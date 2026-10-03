import { expect, it } from "vitest";
import { request } from "node:http";
import {
  createNodeLoopbackListener,
  createMacBrowserOpener,
} from "../src/node-adapters";
import { createOpenAILocalAuth } from "../src/openai";
import { hostId, adapterFixture } from "./adapter-fixture";
const options = {
  host: "127.0.0.1" as const,
  port: 0 as const,
  maxHeaderBytes: 8192,
  maxPendingRequests: 1 as const,
};
function get(port: number, path: string, host = `127.0.0.1:${port}`) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, headers: { Host: host }, method: "GET" },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () =>
          resolve({ status: response.statusCode!, body }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}
it("real loopback listener binds only 127.0.0.1, limits concurrent callbacks and closes on cancellation", async () => {
  const controller = new AbortController();
  const listener = await createNodeLoopbackListener().listen(
    options,
    controller.signal,
  );
  try {
    expect(listener.host).toBe("127.0.0.1");
    expect(listener.port).toBeGreaterThan(0);
    const iterator = listener.requests[Symbol.asyncIterator]();
    const next = iterator.next();
    const reply = get(listener.port, "/auth/callback?code=synthetic");
    const item = (await next).value!;
    expect(item.host).toBe(`127.0.0.1:${listener.port}`);
    expect(item.bodyBytes).toBe(0);
    const duplicate = await get(listener.port, "/auth/callback?code=duplicate");
    expect(duplicate.status).toBe(429);
    expect(duplicate.body).not.toContain("duplicate");
    await item.respond(200, "fixed fixture");
    expect(await reply).toEqual({ status: 200, body: "fixed fixture" });
    const pending = iterator.next();
    controller.abort();
    expect((await pending).done).toBe(true);
    await listener.close();
    await expect(get(listener.port, "/")).rejects.toBeDefined();
  } finally {
    await listener.close();
  }
});
it("invalid binding and pre-cancelled attempts perform no listen", async () => {
  await expect(
    createNodeLoopbackListener().listen(
      { ...options, host: "0.0.0.0" } as unknown as typeof options,
      new AbortController().signal,
    ),
  ).rejects.toBeDefined();
  const c = new AbortController();
  c.abort();
  await expect(
    createNodeLoopbackListener().listen(options, c.signal),
  ).rejects.toMatchObject({ code: "cancelled" });
});
it("gates the exact browser URL before injected launch and never launches denied/substituted/cancelled requests", async () => {
  const f = adapterFixture();
  const auth = createOpenAILocalAuth(hostId, f.transport);
  const attempt = await auth.begin("http://127.0.0.1:24680/auth/callback");
  const intents: unknown[] = [];
  const launches: string[] = [];
  const browser = createMacBrowserOpener(
    async (intent) => {
      intents.push(intent);
    },
    async (url) => {
      launches.push(url);
    },
  );
  await browser.open(attempt.url, new AbortController().signal);
  expect(intents).toHaveLength(1);
  expect(intents[0]).toMatchObject({
    action: "open_chatgpt_sign_in",
    endpoint: "https://auth.openai.com/api/accounts/authorize",
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(JSON.stringify(intents)).not.toContain("nonce");
  expect(launches).toEqual([attempt.url]);
  await expect(
    browser.open(
      attempt.url.replace("auth.openai.com", "other.invalid"),
      new AbortController().signal,
    ),
  ).rejects.toBeDefined();
  const denied = createMacBrowserOpener(
    async () => {
      throw new Error("synthetic-secret");
    },
    async (url) => {
      launches.push(url);
    },
  );
  await expect(
    denied.open(attempt.url, new AbortController().signal),
  ).rejects.toThrow("ChatGPT sign-in authorization failed.");
  const c = new AbortController();
  c.abort();
  await expect(browser.open(attempt.url, c.signal)).rejects.toMatchObject({
    code: "cancelled",
  });
  expect(launches).toHaveLength(1);
});
