import { Readable } from "node:stream";
import { createServer, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import {
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  unlinkSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { resolve, join, isAbsolute } from "node:path";
import { Controller } from "./controller.js";
import { authorized, failure } from "./http.js";
process.umask(0o077);
const args = process.argv.slice(2);
// This executable has no live provider or credential adapter. Explicit fixture mode only.
if (
  args.length !== 3 ||
  args[0] !== "--fixture" ||
  args[1] !== "--data-dir" ||
  !isAbsolute(args[2])
) {
  console.error(
    "Usage: daemon.js --fixture --data-dir <absolute private directory>",
  );
  process.exit(2);
}
const requested = resolve(args[2]);
let owner: DatabaseSync | undefined, controller: Controller | undefined;
async function main() {
  mkdirSync(requested, { recursive: true, mode: 0o700 });
  const info = lstatSync(requested);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.()
  )
    throw new Error("Unsafe data directory");
  const data = realpathSync(requested);
  for (const name of readdirSync(data)) {
    const f = lstatSync(join(data, name));
    if (
      !f.isFile() ||
      f.isSymbolicLink() ||
      f.nlink !== 1 ||
      f.uid !== info.uid ||
      (f.mode & 0o077) !== 0
    )
      throw new Error("Unsafe data file");
  }
  // SQLite DELETE journal EXCLUSIVE transaction retains kernel file locks until process exit.
  // A stale PID never authorizes takeover. No Pi/control store is opened before ownership.
  owner = new DatabaseSync(join(data, "owner.sqlite"));
  owner.exec(
    "PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;",
  );
  const discovery = join(data, "connection.json");
  try {
    unlinkSync(discovery);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const instanceId = randomUUID(),
    authToken = randomBytes(32).toString("hex");
  controller = new Controller(
    new DatabaseSync(join(data, "control.sqlite")),
    join(data, "pi.sqlite"),
    instanceId,
  );
  await controller.start();
  const subscribers = new Set<ServerResponse>();
  let authority = "";
  const server = createServer(async (req, res) => {
    const send = async (response: Response) => {
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    };
    try {
      if (
        req.headers.host !== authority ||
        req.headers.origin !== undefined ||
        !req.url?.startsWith("/") ||
        req.url.startsWith("//")
      ) {
        await send(
          failure(403, "local_transport", "Private local transport required."),
        );
        return;
      }
      const abort = new AbortController();
      res.once("close", () => abort.abort());
      const request = new Request(`http://${authority}${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        ...(req.method === "GET" || req.method === "HEAD"
          ? {}
          : { body: Readable.toWeb(req), duplex: "half" }),
        signal: abort.signal,
      } as RequestInit);
      if (!(await authorized(request, authToken))) {
        await send(
          failure(
            401,
            "unauthorized",
            "Valid bearer authentication is required.",
          ),
        );
        return;
      }
      if (
        req.method === "GET" &&
        new URL(request.url).pathname === "/v1/root/events"
      ) {
        if (subscribers.size >= 8) {
          await send(failure(429, "subscriber_limit", "Too many subscribers."));
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        subscribers.add(res);
        res.once("close", () => subscribers.delete(res));
        if (
          !res.write(
            `event: snapshot\ndata: ${JSON.stringify(controller!.snapshot())}\n\n`,
          )
        )
          res.destroy();
        return;
      }
      await send(await controller!.request(request));
    } catch {
      if (!res.headersSent)
        await send(
          failure(
            500,
            "internal",
            "The server could not complete this request.",
          ),
        );
      else res.destroy();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxConnections = 32;
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Listen failed");
  authority = `127.0.0.1:${address.port}`;
  const metadata = {
    version: 1,
    pid: process.pid,
    instanceId,
    baseUrl: `http://${authority}`,
    authToken,
    configurationRevision: "fixture-v1",
  };
  const temporary = join(data, `connection-${instanceId}.tmp`);
  const fd = openSync(
    temporary,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, JSON.stringify(metadata));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, discovery);
  const directory = openSync(data, constants.O_RDONLY);
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
  let last = "";
  const refresh = setInterval(() => {
    if (!subscribers.size) return;
    const frame = `event: snapshot\ndata: ${JSON.stringify(controller!.snapshot())}\n\n`;
    if (frame === last) return;
    last = frame;
    for (const res of subscribers)
      if (res.writableLength > 0 || !res.write(frame)) res.destroy();
  }, 250);
  const heartbeat = setInterval(() => {
    for (const res of subscribers)
      if (res.writableLength > 0 || !res.write(": heartbeat\n\n"))
        res.destroy();
  }, 5000);
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(refresh);
    clearInterval(heartbeat);
    unlinkSync(discovery);
    for (const res of subscribers) res.destroy();
    server.close();
    server.closeAllConnections();
    const timeout = setTimeout(() => process.exit(1), 5000);
    await controller!.close();
    owner!.close();
    clearTimeout(timeout);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  // Readiness contains no bearer; clients use the protected discovery file.
  console.log("Morons fixture local service ready.");
}
main().catch(() => {
  console.error(
    "Local service startup failed: unsafe state or store already owned.",
  );
  try {
    owner?.close();
  } catch {}
  process.exit(1);
});
