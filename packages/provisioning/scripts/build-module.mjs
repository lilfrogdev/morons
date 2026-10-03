import { build } from "esbuild";
// Bundle the canonical backend selection contract, keeping the packaged bridge
// path stable and avoiding a second provider/model/endpoint allowlist in Node.
await build({
  entryPoints: ["src/index.ts", "src/bridge.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outdir: "dist/src",
});
