import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  mkdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const backend = resolve(root, "../backend");
const temporary = await mkdtemp(join(tmpdir(), "morons-provisioning-build-"));
try {
  // No shell or user config/credential environment. Pinned Wrangler and fixed
  // backend config only; dry-run never uploads a Worker or creates resources.
  const result = spawnSync(
    process.execPath,
    [
      join(backend, "node_modules/wrangler/bin/wrangler.js"),
      "deploy",
      "--dry-run",
      "--env=",
      "--config",
      join(backend, "wrangler.jsonc"),
      "--outdir",
      join(temporary, "bundle"),
    ],
    {
      cwd: backend,
      env: {
        PATH: dirname(process.execPath),
        HOME: temporary,
        XDG_CONFIG_HOME: temporary,
        WRANGLER_HOME: temporary,
        WRANGLER_SEND_METRICS: "false",
        CI: "true",
      },
      stdio: "ignore",
      timeout: 120_000,
    },
  );
  if (result.status !== 0)
    throw new Error(
      "Backend dry-run build failed; run npm ci in packages/backend first.",
    );
  const outputNames = await readdir(join(temporary, "bundle"));
  if (
    outputNames.some(
      (name) => !/\.m?js(?:\.map)?$/.test(name) && name !== "README.md",
    )
  )
    throw new Error(
      "Unsupported backend build asset; do not silently omit it.",
    );
  const names = outputNames.filter((name) => /\.m?js$/.test(name)).sort();
  if (!names.includes("worker.js"))
    throw new Error("Expected backend worker.js bundle is missing.");
  const modules = await Promise.all(
    names.map(async (name) => ({
      name,
      content: await readFile(join(temporary, "bundle", name), "utf8"),
    })),
  );
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(
    join(root, "dist/backend-bundle.json"),
    JSON.stringify({ mainModule: "worker.js", modules }),
  );
  process.stdout.write(
    "Built backend-bundle.json from the pinned local backend (dry-run).\n",
  );
} catch {
  process.stderr.write(
    "Backend bundle build failed. Install the pinned backend dependencies and retry the local dry-run.\n",
  );
  process.exitCode = 1;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
