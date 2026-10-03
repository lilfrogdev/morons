import { afterEach, describe, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const token = "morons-local-test-token-0000000000000000";
const runtimes: Miniflare[] = [];
const dirs: string[] = [];
execFileSync(
  process.execPath,
  [
    "node_modules/wrangler/bin/wrangler.js",
    "deploy",
    "--env",
    "local",
    "--dry-run",
    "--outdir",
    "/tmp/morons-backend-test-bundle",
  ],
  { stdio: "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
);
async function start(persist?: string, auth: string | undefined = token) {
  const mf = new Miniflare({
    ...convertV4MiniflareOptions({
      name: "morons-test",
      modulesRoot: "/tmp/morons-backend-test-bundle",
      modules: true,
      scriptPath: "/tmp/morons-backend-test-bundle/local.js",
      compatibilityDate: "2026-10-02",
      compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
      durableObjects: { ROOT: { className: "RootChat", useSQLite: true } },
      durableObjectsPersist: persist,
      bindings: {
        MODEL_ID: "mock",
        ...(auth === undefined ? {} : { AUTH_TOKEN: auth }),
      },
    }),
    resourcePersistencePath: persist,
    unsafeInspectDurableObjects: true,
  });
  runtimes.push(mf);
  await mf.ready;
  return mf;
}
function api(
  mf: Miniflare,
  path: string,
  method = "GET",
  body?: unknown,
  auth = token,
) {
  return mf.dispatchFetch(`http://localhost/v1/root/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${auth}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
async function wait(mf: Miniflare, taskId = id) {
  for (let n = 0; n < 100; n++) {
    const result = (await (await api(mf, `tasks/${taskId}`)).json()) as any;
    if (["completed", "failed", "stopped"].includes(result.task.status))
      return result.task;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Task did not settle");
}
afterEach(async () => {
  for (const mf of runtimes.splice(0)) await mf.dispose();
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
describe("local SQLite/Pi backend", () => {
  it("authenticates every route, fails closed with absent configuration and spoofed Host", async () => {
    const mf = await start();
    expect((await api(mf, "snapshot", "GET", undefined, "wrong")).status).toBe(
      401,
    );
    expect(
      (
        await mf.dispatchFetch("http://evil.example/v1/root/status", {
          headers: { Host: "localhost" },
        })
      ).status,
    ).toBe(401);
    const closed = await start(undefined, "");
    expect((await api(closed, "status")).status).toBe(401);
    expect(
      (await api(mf, `tasks/${id}/stop`, "POST", undefined, "wrong")).status,
    ).toBe(401);
  });
  it("submits durably, rejects conflicting IDs and busy work, and survives retry and reconnect", async () => {
    const mf = await start();
    const first = await api(mf, "tasks", "POST", {
      requestId: id,
      text: "slow: hello",
    });
    expect(first.status).toBe(202);
    expect(
      (await api(mf, "tasks", "POST", { requestId: id, text: "slow: hello" }))
        .status,
    ).toBe(200);
    expect(
      (await api(mf, "tasks", "POST", { requestId: id, text: "different" }))
        .status,
    ).toBe(409);
    expect(
      (
        await api(mf, "tasks", "POST", {
          requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          text: "second",
        })
      ).status,
    ).toBe(409);
    const stream = await api(mf, "events"),
      reader = stream.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "event: snapshot",
    );
    await reader.cancel();
    expect((await wait(mf)).status).toBe("completed");
    const reconnect = await api(mf, "events"),
      again = reconnect.body!.getReader();
    const frame = new TextDecoder().decode((await again.read()).value);
    const snapshot = JSON.parse(frame.split("data: ")[1]);
    expect(snapshot.messages.map((m: any) => m.text)).toEqual([
      "slow: hello",
      "Mock: slow: hello",
    ]);
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.activeTaskId).toBe(null);
    await again.cancel();
    expect(
      (await api(mf, "tasks", "POST", { requestId: id, text: "slow: hello" }))
        .status,
    ).toBe(200);
  });
  it("stops exact work and reports provider failure without raw details", async () => {
    const mf = await start();
    await api(mf, "tasks", "POST", { requestId: id, text: "slow: stop" });
    expect(
      ((await (await api(mf, `tasks/${id}/stop`, "POST", {})).json()) as any)
        .task.status,
    ).toBe("stopped");
    expect((await api(mf, `tasks/${id}/stop`, "POST", {})).status).toBe(200);
    const failId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await api(mf, "tasks", "POST", { requestId: failId, text: "fail" });
    expect((await wait(mf, failId)).error).toBe(
      "Model execution failed or exceeded its limits.",
    );
  });
  it("validates request type, UUID, strict keys, and UTF-8 byte bounds", async () => {
    const mf = await start();
    for (const body of [
      { requestId: "bad", text: "hi" },
      { requestId: id, text: "" },
      { requestId: id, text: "hi", extra: true },
    ])
      expect((await api(mf, "tasks", "POST", body)).status).toBe(400);
    expect(
      (
        await api(mf, "tasks", "POST", {
          requestId: id,
          text: "😀".repeat(2049),
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await api(mf, "tasks", "POST", {
          requestId: id,
          text: "x".repeat(70000),
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await mf.dispatchFetch("http://localhost/v1/root/tasks", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "text/plain",
          },
          body: "{}",
        })
      ).status,
    ).toBe(415);
  });
  it("recovers accepted work across runtime restart with one result and one request identity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "morons-restart-"));
    dirs.push(dir);
    const first = await start(dir);
    await api(first, "tasks", "POST", { requestId: id, text: "slow: restart" });
    await first.dispose();
    runtimes.splice(runtimes.indexOf(first), 1);
    const restarted = await start(dir);
    expect(
      (
        await api(restarted, "tasks", "POST", {
          requestId: id,
          text: "slow: restart",
        })
      ).status,
    ).toBe(200);
    expect((await wait(restarted)).status).toBe("completed");
    const snapshot = (await (await api(restarted, "snapshot")).json()) as any;
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.messages).toHaveLength(2);
  });
  it("keeps simultaneous subscribers coherent and bounds history without deleting it", async () => {
    const mf = await start();
    const one = (await api(mf, "events")).body!.getReader();
    const two = (await api(mf, "events")).body!.getReader();
    await one.read();
    await two.read();
    await api(mf, "tasks", "POST", {
      requestId: id,
      text: "hello subscribers",
    });
    await wait(mf);
    const readFinal = async (reader: typeof one) => {
      for (let n = 0; n < 5; n++) {
        const frame = new TextDecoder().decode((await reader.read()).value);
        if (!frame.includes("data: ")) continue;
        const snapshot = JSON.parse(frame.split("data: ")[1]);
        if (snapshot.tasks[0]?.status === "completed") return snapshot;
      }
      throw new Error("No final subscriber snapshot");
    };
    expect(await readFinal(one)).toEqual(await readFinal(two));
    await one.cancel();
    await two.cancel();
    const store = await mf.unsafeGetDurableObjectStorage(
      "morons-test",
      "RootChat",
      { name: "root" },
    );
    // Populate the admissible worst-case history without spending model tokens.
    for (let n = 0; n < 199; n++)
      await store.exec(
        "INSERT INTO morons_tasks(id,status,input,createdAt,updatedAt,answer) VALUES(?, 'completed', ?, 1, 1, ?)",
        `fixture-${n}`,
        "\u0000".repeat(120),
        "x".repeat(900),
      );
    const snapshot = await api(mf, "snapshot");
    expect(new TextEncoder().encode(await snapshot.text()).length).toBeLessThan(
      2 * 1024 * 1024,
    );
    const denied = await api(mf, "tasks", "POST", {
      requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      text: "new",
    });
    expect(denied.status).toBe(429);
    expect(
      ((await (await api(mf, "snapshot")).json()) as any).tasks,
    ).toHaveLength(200);
  });
  it("recovers an admission interrupted before Pi submit and denies exhausted model attempts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "morons-admission-"));
    dirs.push(dir);
    const first = await start(dir);
    await api(first, "status");
    const store = await first.unsafeGetDurableObjectStorage(
      "morons-test",
      "RootChat",
      { name: "root" },
    );
    await store.exec(
      "INSERT INTO morons_tasks(id,status,input,createdAt,updatedAt) VALUES(?, 'accepted', 'admission gap', 1, 1)",
      id,
    );
    await first.dispose();
    runtimes.splice(runtimes.indexOf(first), 1);
    const restarted = await start(dir);
    await api(restarted, "status");
    expect((await wait(restarted)).status).toBe("completed");
    const exhausted = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const secondStore = await restarted.unsafeGetDurableObjectStorage(
      "morons-test",
      "RootChat",
      { name: "root" },
    );
    await secondStore.exec(
      "INSERT INTO morons_tasks(id,status,input,createdAt,updatedAt,attempts) VALUES(?, 'accepted', 'exhausted', 2, 2, 2)",
      exhausted,
    );
    await restarted.dispose();
    runtimes.splice(runtimes.indexOf(restarted), 1);
    const third = await start(dir);
    await api(third, "status");
    expect((await wait(third, exhausted)).status).toBe("failed");
    const thirdStore = await third.unsafeGetDurableObjectStorage(
      "morons-test",
      "RootChat",
      { name: "root" },
    );
    expect(
      (
        await thirdStore.exec(
          "SELECT attempts FROM morons_tasks WHERE id = ?",
          exhausted,
        )
      )[0].attempts,
    ).toBe(2);
  });

  it("wakes and finishes after restart without a desktop request", async () => {
    const dir = await mkdtemp(join(tmpdir(), "morons-alarm-"));
    dirs.push(dir);
    const first = await start(dir);
    await api(first, "tasks", "POST", {
      requestId: id,
      text: "slow: autonomous wake",
    });
    await first.dispose();
    runtimes.splice(runtimes.indexOf(first), 1);
    const restarted = await start(dir);
    // PiHarness schedules a 30-second heartbeat before durable submission.
    await new Promise((resolve) => setTimeout(resolve, 35000));
    const snapshot = (await (await api(restarted, "snapshot")).json()) as any;
    expect(snapshot.tasks[0].status).toBe("completed");
    expect(snapshot.messages.at(-1).text).toBe("Mock: slow: autonomous wake");
  }, 45000);
  it("returns actionable history capacity errors while preserving existing messages", async () => {
    const mf = await start();
    await api(mf, "status");
    const store = await mf.unsafeGetDurableObjectStorage(
      "morons-test",
      "RootChat",
      { name: "root" },
    );
    for (let n = 0; n < 2; n++)
      await store.exec(
        "INSERT INTO morons_tasks(id,status,input,createdAt,updatedAt,answer) VALUES(?, 'completed', 'history', 1, 1, ?)",
        `history-${n}`,
        "\u0000".repeat(32768),
      );
    const denied = await api(mf, "tasks", "POST", {
      requestId: id,
      text: "new",
    });
    expect(denied.status).toBe(429);
    expect(((await denied.json()) as any).error.code).toBe("history_limit");
    expect(
      ((await (await api(mf, "snapshot")).json()) as any).messages,
    ).toHaveLength(4);
  });
  it("bounds concurrent subscriber admission", async () => {
    const mf = await start();
    const networkEvents = async () =>
      fetch(new URL("/v1/root/events", await mf.ready), {
        headers: { Authorization: `Bearer ${token}` },
      });
    const responses = await Promise.all(
      Array.from({ length: 9 }, networkEvents),
    );
    expect(
      responses.filter((response) => response.status === 200),
    ).toHaveLength(8);
    expect(
      responses.filter((response) => response.status === 429),
    ).toHaveLength(1);
    for (const response of responses)
      if (response.status === 200) {
        const reader = response.body!.getReader();
        await reader.read();
        await reader.cancel();
      }
    // Cancellation crosses the Worker/DO stream proxy asynchronously.
    let replacement = await networkEvents();
    for (
      let attempt = 0;
      replacement.status === 429 && attempt < 80;
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      replacement = await networkEvents();
    }
    expect(replacement.status).toBe(200);
    await replacement.body!.cancel();
  }, 10000);
});
