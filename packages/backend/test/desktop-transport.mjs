import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const backend = fileURLToPath(new URL("../", import.meta.url));
const manifest = fileURLToPath(
  new URL("../../../apps/desktop/Cargo.toml", import.meta.url),
);
try {
  await access(manifest);
  await access(
    fileURLToPath(
      new URL("../../../apps/desktop/tests/local_backend.rs", import.meta.url),
    ),
  );
} catch {
  throw new Error(
    "Desktop integration prerequisite missing: combine the native desktop PR and its tests/local_backend.rs test with this backend checkout before running npm run test:desktop.",
  );
}
const bundle = await mkdtemp(join(tmpdir(), "morons-transport-"));
const token = "morons-integration-fixture-only-0000000000";
let runtime;
async function run(command, args, env = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: backend,
      stdio: "inherit",
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", ...env },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal}`));
    });
  });
}
try {
  // Only bundle the local mock entry point. No deployment or provider requests.
  await run(process.execPath, [
    "node_modules/wrangler/bin/wrangler.js",
    "deploy",
    "--env",
    "local",
    "--dry-run",
    "--outdir",
    bundle,
  ]);
  runtime = new Miniflare({
    ...convertV4MiniflareOptions({
      name: "morons-transport-test",
      modulesRoot: bundle,
      modules: true,
      scriptPath: join(bundle, "local.js"),
      compatibilityDate: "2026-10-02",
      compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
      durableObjects: { ROOT: { className: "RootChat", useSQLite: true } },
      bindings: { MODEL_ID: "mock", AUTH_TOKEN: token },
    }),
    host: "127.0.0.1",
    port: 0,
  });
  const url = await runtime.ready;
  await run(
    "cargo",
    [
      "test",
      "--locked",
      "--manifest-path",
      manifest,
      "--no-default-features",
      "--test",
      "local_backend",
      "--",
      "--ignored",
      "--nocapture",
    ],
    {
      MORONS_TEST_BACKEND_URL: url.href,
      MORONS_TEST_BACKEND_TOKEN: token,
    },
  );
} finally {
  await runtime?.dispose();
  await rm(bundle, { recursive: true, force: true });
}
