import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { spawn } from "node:child_process";
import type { Socket } from "node:net";
import type {
  BrowserOpener,
  BoundListener,
  CallbackRequest,
  LoopbackListenerFactory,
} from "./loopback";
import { FlowError, LOOPBACK_LIMITS } from "./loopback";

const FAILURE =
  "<!doctype html><title>Morons</title><p>Sign-in was not completed.</p>";
function respond(response: ServerResponse, status: number, html: string) {
  return new Promise<void>((resolve) => {
    response.once("close", resolve);
    response.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      Connection: "close",
    });
    response.end(html, resolve);
  });
}
// Binds only on explicit listen(), never on module import. This listener has no
// public service routes; it exists solely for one exact OAuth callback attempt.
export function createNodeLoopbackListener(): LoopbackListenerFactory {
  return {
    async listen(options, signal): Promise<BoundListener> {
      if (
        options.host !== "127.0.0.1" ||
        options.port !== 0 ||
        options.maxHeaderBytes !== LOOPBACK_LIMITS.maxHeaderBytes ||
        options.maxPendingRequests !== 1 ||
        signal.aborted
      )
        throw new FlowError("cancelled");
      const sockets = new Set<Socket>();
      let closed = false;
      let inFlight = false;
      let queued: CallbackRequest | undefined;
      let waiting:
        | ((value: IteratorResult<CallbackRequest>) => void)
        | undefined;
      const server = createServer(
        { maxHeaderSize: options.maxHeaderBytes },
        (request: IncomingMessage, response: ServerResponse) => {
          if (closed || inFlight) {
            void respond(response, 429, FAILURE);
            request.resume();
            return;
          }
          const hostCount = request.rawHeaders.filter(
            (_, index) =>
              index % 2 === 0 &&
              request.rawHeaders[index].toLowerCase() === "host",
          ).length;
          const length = request.headers["content-length"];
          const hasBody =
            request.headers["transfer-encoding"] !== undefined ||
            (length !== undefined && length !== "0");
          const target = request.url ?? "";
          if (
            new TextEncoder().encode(target).byteLength >
            LOOPBACK_LIMITS.maxTargetBytes
          ) {
            void respond(response, 414, FAILURE);
            request.resume();
            return;
          }
          inFlight = true;
          let responded = false;
          const item: CallbackRequest = {
            method: request.method ?? "",
            target,
            host: hostCount === 1 ? (request.headers.host ?? "") : "",
            headerBytes: request.rawHeaders.reduce(
              (total, value) => total + Buffer.byteLength(value) + 4,
              0,
            ),
            bodyBytes: hasBody ? 1 : 0,
            respond: async (status, html) => {
              if (responded) return;
              responded = true;
              try {
                await respond(response, status, html);
              } finally {
                inFlight = false;
                request.resume();
              }
            },
          };
          // Do not buffer callback bodies, even for requests the coordinator rejects.
          request.resume();
          if (waiting) {
            const next = waiting;
            waiting = undefined;
            next({ done: false, value: item });
          } else queued = item;
        },
      );
      server.maxConnections = 4;
      server.requestTimeout = 5000;
      server.headersTimeout = 5000;
      server.keepAliveTimeout = 1000;
      server.maxRequestsPerSocket = 1;
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.setTimeout(5000, () => socket.destroy());
        socket.once("close", () => sockets.delete(socket));
      });
      server.on("clientError", (_error, socket) => {
        socket.end(
          "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        );
      });
      const close = async () => {
        closed = true;
        signal.removeEventListener("abort", abort);
        waiting?.({ done: true, value: undefined });
        waiting = undefined;
        queued = undefined;
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          if (!server.listening) resolve();
        });
      };
      const abort = () => {
        void close();
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen({ host: options.host, port: options.port }, () => {
            server.removeListener("error", reject);
            resolve();
          });
        });
        if (signal.aborted || closed) {
          await close();
          throw new FlowError("cancelled");
        }
        const address = server.address();
        if (!address || typeof address === "string")
          throw new FlowError("authorization_failed");
        server.on("error", () => {
          void close();
        });
        return {
          host: "127.0.0.1",
          port: address.port,
          close,
          requests: {
            [Symbol.asyncIterator]() {
              return {
                next: async () => {
                  if (closed) return { done: true, value: undefined };
                  if (queued) {
                    const value = queued;
                    queued = undefined;
                    return { done: false, value };
                  }
                  if (waiting) throw new FlowError("authorization_failed");
                  return new Promise<IteratorResult<CallbackRequest>>(
                    (resolve) => {
                      waiting = resolve;
                    },
                  );
                },
              };
            },
          },
        };
      } catch {
        await close();
        throw new FlowError(
          signal.aborted ? "cancelled" : "authorization_failed",
        );
      }
    },
  };
}
export interface BrowserIntent {
  action: "open_chatgpt_sign_in";
  endpoint: "https://auth.openai.com/api/accounts/authorize";
  sha256: string;
}
export type BrowserApproval = (
  intent: BrowserIntent,
  signal: AbortSignal,
) => Promise<void>;
export type LaunchBrowser = (url: string, signal: AbortSignal) => Promise<void>;
// The injected gate must consume an exact, explicit user action. No implicit
// gate or browser launch is provided on construction. Tests inject a fake launch.
export function createMacBrowserOpener(
  approve: BrowserApproval,
  launch: LaunchBrowser = async (url, signal) => {
    if (process.platform !== "darwin")
      throw new FlowError("authorization_failed");
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/usr/bin/open", [url], {
        shell: false,
        env: {},
        stdio: "ignore",
        signal,
      });
      child.once("error", () => reject(new FlowError("authorization_failed")));
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new FlowError("authorization_failed")),
      );
    });
  },
): BrowserOpener {
  return {
    async open(value, signal) {
      try {
        signal.throwIfAborted();
        const url = new URL(value);
        if (
          url.origin + url.pathname !==
            "https://auth.openai.com/api/accounts/authorize" ||
          url.username ||
          url.password ||
          url.hash ||
          value.length > 8192
        )
          throw new FlowError("authorization_failed");
        const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
        if (
          redirect.protocol !== "http:" ||
          redirect.hostname !== "127.0.0.1" ||
          !redirect.port ||
          redirect.pathname !== "/auth/callback" ||
          redirect.search ||
          redirect.hash ||
          redirect.username ||
          redirect.password ||
          url.searchParams.get("response_type") !== "code" ||
          url.searchParams.get("code_challenge_method") !== "S256"
        )
          throw new FlowError("authorization_failed");
        for (const name of [
          "client_id",
          "state",
          "nonce",
          "code_challenge",
          "redirect_uri",
        ])
          if (
            url.searchParams.getAll(name).length !== 1 ||
            !url.searchParams.get(name)
          )
            throw new FlowError("authorization_failed");
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(value),
        );
        await approve(
          {
            action: "open_chatgpt_sign_in",
            endpoint: "https://auth.openai.com/api/accounts/authorize",
            sha256: Buffer.from(digest).toString("hex"),
          },
          signal,
        );
        signal.throwIfAborted();
        await launch(value, signal);
        signal.throwIfAborted();
      } catch {
        throw new FlowError(
          signal.aborted ? "cancelled" : "authorization_failed",
        );
      }
    },
  };
}
