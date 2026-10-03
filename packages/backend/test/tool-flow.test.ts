import { afterEach, describe, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const token = "morons-tool-fixture-owner-00000000000000000",
  id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const runtimes: Miniflare[] = [],
  dirs: string[] = [];
const bundle = "/tmp/morons-tool-approval-flow";
execFileSync(
  process.execPath,
  [
    "node_modules/wrangler/bin/wrangler.js",
    "deploy",
    "--env",
    "local",
    "--dry-run",
    "--outdir",
    bundle,
  ],
  { stdio: "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
);
async function start(persist?: string) {
  const mf = new Miniflare({
    ...convertV4MiniflareOptions({
      name: "morons-tool-test",
      modulesRoot: bundle,
      modules: true,
      scriptPath: `${bundle}/local.js`,
      compatibilityDate: "2026-10-02",
      compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
      durableObjects: { ROOT: { className: "RootChat", useSQLite: true } },
      durableObjectsPersist: persist,
      bindings: { MODEL_ID: "mock", AUTH_TOKEN: token },
    }),
    resourcePersistencePath: persist,
    unsafeInspectDurableObjects: true,
  });
  runtimes.push(mf);
  await mf.ready;
  return mf;
}
function api(mf: Miniflare, path: string, body?: unknown, auth = token) {
  return mf.dispatchFetch(`http://localhost/v1/root/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${auth}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function snapshot(mf: Miniflare) {
  return (await (await api(mf, "snapshot")).json()) as any;
}
async function until(mf: Miniflare, predicate: (value: any) => boolean) {
  for (let n = 0; n < 100; n++) {
    const value = await snapshot(mf);
    if (predicate(value)) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Fixture did not settle");
}
afterEach(async () => {
  for (const mf of runtimes.splice(0)) await mf.dispose();
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
describe("offline Pi tools and approval routes", () => {
  it("uses read-only UTC tool without external access", async () => {
    const mf = await start();
    await api(mf, "tasks", { requestId: id, text: "tool:time" });
    const value = await until(mf, (s) => s.tasks[0]?.status === "completed");
    expect(value.messages[1].text).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(value.approvals).toEqual([]);
  });
  it("remains idle, survives runtime restart, then approves exactly once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "morons-tool-"));
    dirs.push(dir);
    const first = await start(dir);
    await api(first, "tasks", {
      requestId: id,
      text: "tool:confirm:Confirm this message only",
    });
    const pending = await until(
      first,
      (s) => s.approvals[0]?.state === "pending",
    );
    const record = pending.approvals[0];
    const storage = await first.unsafeGetDurableObjectStorage(
      "morons-tool-test",
      "RootChat",
      { name: "root" },
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(
      (
        await storage.exec("SELECT attempts FROM morons_tasks WHERE id = ?", id)
      )[0].attempts,
    ).toBe(1);
    await first.dispose();
    runtimes.splice(runtimes.indexOf(first), 1);
    const restarted = await start(dir);
    const recovered = await until(
      restarted,
      (s) => s.approvals[0]?.state === "pending",
    );
    expect(recovered.approvals[0].id).toBe(record.id);
    expect(recovered.tasks[0].status).toBe("running");
    const decision = { taskId: id, digest: record.digest, decision: "approve" };
    expect(
      (
        await api(
          restarted,
          `approvals/${record.id}/decision`,
          decision,
          "wrong",
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await api(restarted, `approvals/${record.id}/decision`, {
          ...decision,
          digest: "0".repeat(64),
        })
      ).status,
    ).toBe(409);
    expect(
      (await api(restarted, `approvals/${record.id}/decision`, decision))
        .status,
    ).toBe(200);
    expect(
      (await api(restarted, `approvals/${record.id}/decision`, decision))
        .status,
    ).toBe(409);
    const settled = await until(
      restarted,
      (s) => s.tasks[0].status === "completed",
    );
    expect(settled.approvals[0].state).toBe("consumed");
    expect(settled.messages[1].text).toContain("Confirmation approved");
  });
  it.each(["deny", "stop", "expire"])(
    "settles %s without authorization",
    async (mode) => {
      const mf = await start();
      await api(mf, "tasks", { requestId: id, text: "tool:confirm:Confirm" });
      const value = await until(mf, (s) => s.approvals[0]?.state === "pending"),
        record = value.approvals[0];
      if (mode === "deny")
        expect(
          (
            await api(mf, `approvals/${record.id}/decision`, {
              taskId: id,
              digest: record.digest,
              decision: "deny",
            })
          ).status,
        ).toBe(200);
      if (mode === "stop") await api(mf, `tasks/${id}/stop`, {});
      if (mode === "expire") {
        const storage = await mf.unsafeGetDurableObjectStorage(
          "morons-tool-test",
          "RootChat",
          { name: "root" },
        );
        await storage.exec(
          "UPDATE morons_approvals SET expiresAt = 1 WHERE id = ?",
          record.id,
        );
        await api(mf, "approvals");
      }
      const settled = await until(mf, (s) =>
        ["completed", "stopped"].includes(s.tasks[0]?.status),
      );
      expect(settled.approvals[0].state).toBe(
        mode === "deny" ? "denied" : mode === "stop" ? "cancelled" : "expired",
      );
    },
  );
});
