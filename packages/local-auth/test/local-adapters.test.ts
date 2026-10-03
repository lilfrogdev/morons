import { expect, it, vi } from "vitest";
import { createOpenAILocalAuth } from "../src/openai";
import { keychainSessionIO } from "../src/keychain-broker";
import { subscriptionModels } from "../src/pi-subscription";
import { subscriptionPayload } from "../src/pi-payload";
import {
  adapterFixture,
  hostId,
  identity,
  secret,
  sse,
} from "./adapter-fixture";

it("persists a verified whole bundle through an approved private slot, then restores without browser or grant", async () => {
  const f = adapterFixture();
  const auth = await f.auth();
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0].phase).toBe("ready");
  expect(f.intents[0]).toMatchObject({
    action: "write",
    identity,
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(JSON.stringify(f.intents)).not.toContain(secret);
  const restored = createOpenAILocalAuth(hostId, f.transport);
  restored.attachProtectedIO(f.io);
  const count = f.calls.length;
  await restored.restore(identity);
  await restored.withAccessToken(async (token) => {
    expect(token).toBe(`${secret}-0`);
  });
  expect(f.calls).toHaveLength(count);
  expect(f.intents.at(-1)?.action).toBe("read");
  expect(JSON.stringify(restored)).not.toContain(secret);
  expect(restored.identity()).toEqual(auth.identity());
});
it("commits a rotation intent before exactly one serialized refresh and commits the replacement bundle", async () => {
  const f = adapterFixture();
  f.expires(120);
  const auth = await f.auth();
  f.expires(3600);
  await Promise.all([auth.refresh(), auth.refresh()]);
  expect(f.writes.map((r) => r.phase)).toEqual([
    "ready",
    "refreshing",
    "ready",
  ]);
  const refreshes = f.calls.filter(
    (c) =>
      c.init.body instanceof URLSearchParams &&
      c.init.body.get("grant_type") === "refresh_token",
  );
  expect(refreshes).toHaveLength(1);
  expect(
    new URLSearchParams(refreshes[0].init.body as URLSearchParams).has("scope"),
  ).toBe(false);
  expect(f.writes.at(-1).tokens.refreshToken).toBe(`${secret}-refresh-1`);
});
it("refuses interrupted rotations and another host/account/client on restart", async () => {
  const f = adapterFixture();
  await f.auth();
  const saved = f.writes[0];
  for (const change of [
    { phase: "refreshing" },
    { phase: "reauth_required" },
    { hostId: "urn:uuid:22222222-2222-4222-8222-222222222222" },
    {
      tokens: { ...saved.tokens, identity: { ...identity, subject: "other" } },
    },
  ]) {
    f.values.set(
      [...f.values.keys()][0],
      JSON.stringify({ ...saved, ...change }),
    );
    const auth = createOpenAILocalAuth(hostId, f.transport);
    auth.attachProtectedIO(f.io);
    await expect(auth.restore(identity)).rejects.toMatchObject({
      code: "reauth_required",
    });
  }
  const auth = createOpenAILocalAuth(hostId, f.transport);
  auth.attachProtectedIO(f.io);
  await expect(
    auth.restore({ ...identity, clientId: "other_client" }),
  ).rejects.toMatchObject({ code: "reauth_required" });
});
it("blocks inference when initial write or rotation intent/replacement commit is denied or uncertain", async () => {
  for (const failure of [1, 2, 3]) {
    const f = adapterFixture();
    f.expires(120);
    let writes = 0;
    f.approveStorage(async (intent) => {
      if (intent.action === "write" && ++writes === failure)
        throw new Error(secret);
    });
    if (failure === 1) {
      await expect(f.auth()).rejects.toMatchObject({
        code: "validation_failed",
      });
      expect(f.values.size).toBe(0);
      continue;
    }
    const auth = await f.auth();
    f.expires(3600);
    await expect(auth.refresh()).rejects.toMatchObject({
      code: "reauth_required",
    });
    const calls = f.calls.length;
    await expect(
      auth.withAccessToken(async () => {
        throw new Error("must not execute");
      }),
    ).rejects.toMatchObject({ code: "reauth_required" });
    expect(f.calls).toHaveLength(calls);
    expect(
      f.calls.filter(
        (c) =>
          c.init.body instanceof URLSearchParams &&
          c.init.body.get("grant_type") === "refresh_token",
      ),
    ).toHaveLength(failure === 2 ? 0 : 1);
  }
});
it("honors an earliest refresh floor and rejects unsupported floor formats", async () => {
  const f = adapterFixture();
  f.expires(120);
  f.floor(Math.floor(Date.now() / 1000) + 60);
  const auth = await f.auth();
  const count = f.calls.length;
  await auth.refresh();
  expect(f.calls).toHaveLength(count);
  for (const value of [
    "not-a-timestamp",
    {},
    Math.floor(Date.now() / 1000) + 7200,
  ]) {
    const g = adapterFixture();
    g.floor(value);
    await expect(g.auth()).rejects.toMatchObject({ code: "validation_failed" });
    expect(g.writes).toHaveLength(0);
  }
});
it("sanitizes protected broker errors and validates identity before approval or IPC", async () => {
  let approves = 0,
    runs = 0;
  const io = keychainSessionIO(
    hostId,
    async () => {
      approves++;
    },
    async () => {
      runs++;
      throw new Error(secret);
    },
  );
  await expect(
    io.read({ ...identity, issuer: "https://other.invalid" }),
  ).rejects.toThrow("ChatGPT sign-in reauth required.");
  expect(approves).toBe(0);
  expect(runs).toBe(0);
  await expect(io.read(identity)).rejects.toThrow(
    "ChatGPT sign-in reauth required.",
  );
  expect(approves).toBe(1);
  expect(runs).toBe(1);
});
it("starts disconnected, exposes only verified identity/catalog, selects explicitly and restores after service restart", async () => {
  const f = adapterFixture();
  const service = f.service();
  expect(service.status()).toMatchObject({
    phase: "disconnected",
    models: [],
    billing: "subscription",
    executionHost: "local",
  });
  expect(f.calls).toHaveLength(0);
  await service.begin();
  expect(service.status().selectedModelId).toBeUndefined();
  await service.refreshCatalog();
  expect(service.status().models).toEqual([{ id: "gpt-5-mini", name: "Mini" }]);
  expect(() =>
    service.selectModel("private", service.status().configurationRevision),
  ).toThrow();
  const selected = service.selectModel(
    "gpt-5-mini",
    service.status().configurationRevision,
  );
  expect(selected.selectedModelId).toBe("gpt-5-mini");
  expect(JSON.stringify(selected)).not.toContain(secret);
  service.disconnect();
  const next = f.service();
  await next.load(identity);
  expect(next.status()).toMatchObject({ phase: "connected", models: [] });
  expect(next.status().selectedModelId).toBeUndefined();
});
it("invalidates stale model selections and approvals, and cannot reconnect after disconnect during a pending catalog approval", async () => {
  const f = adapterFixture();
  const service = f.service();
  await service.begin();
  await service.refreshCatalog();
  const old = service.status().configurationRevision;
  await service.refreshCatalog();
  expect(() => service.selectModel("gpt-5-mini", old)).toThrow();
  let resolve!: () => void;
  f.approveCatalog(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const request = service.refreshCatalog();
  await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
  service.disconnect();
  resolve();
  await expect(request).rejects.toMatchObject({ code: "invalid_attempt" });
  expect(service.status().phase).toBe("disconnected");
});
it("requires reauthorization after uncertain rotation and does not retry the failed grant", async () => {
  const f = adapterFixture();
  f.expires(120);
  const service = f.service();
  await service.begin();
  f.failToken();
  await expect(service.refreshCatalog()).rejects.toMatchObject({
    code: "reauth_required",
  });
  expect(service.status().phase).toBe("reauth_required");
  expect(f.writes.at(-1).phase).toBe("reauth_required");
  const count = f.calls.length;
  await expect(service.refreshCatalog()).rejects.toMatchObject({
    code: "reauth_required",
  });
  expect(f.calls).toHaveLength(count);
});
async function prepared() {
  const f = adapterFixture();
  const service = f.service();
  await service.begin();
  await service.refreshCatalog();
  service.selectModel("gpt-5-mini", service.status().configurationRevision);
  return { ...f, serviceInstance: service };
}
const context = {
  systemPrompt: "Personal workspace",
  messages: [{ role: "user" as const, content: "hello", timestamp: 1 }],
};
it("uses maintained Pi against a synthetic SSE response with the exact approved subscription body and no credential-shape dispatch", async () => {
  const f = await prepared();
  const approvals: any[] = [];
  const models = subscriptionModels(
    f.serviceInstance,
    f.serviceInstance.status().configurationRevision,
    async (intent) => {
      approvals.push(intent);
    },
    f.transport,
  );
  const model = models.getModel("openai", "gpt-5-mini")!;
  const result = await models.completeSimple(model, context, {
    sessionId: "session_fixture",
  });
  expect(result.stopReason).toBe("stop");
  expect(approvals).toHaveLength(1);
  expect(approvals[0]).toMatchObject({
    action: "subscription_inference",
    billing: "subscription",
    endpoint: "https://api.openai.com/v1/responses",
    model: "gpt-5-mini",
  });
  const call = f.calls.find((c) => c.url.endsWith("/responses"))!;
  expect(call).toBeDefined();
  expect(new Headers(call.init.headers).get("authorization")).toBe(
    `Bearer ${secret}-0`,
  );
  const body = JSON.parse(call.init.body as string);
  expect(body).toMatchObject({
    model: "gpt-5-mini",
    store: false,
    stream: true,
    input: [
      { role: "developer", content: "Personal workspace" },
      { role: "user" },
    ],
  });
  expect(body.max_output_tokens).toBeUndefined();
  expect(JSON.stringify(body)).not.toContain(secret);
  expect(JSON.stringify(approvals)).not.toContain(secret);
  expect(
    f.calls
      .map((c) => c.url)
      .every(
        (url) =>
          url.startsWith("https://auth.openai.com/") ||
          url.startsWith("https://api.openai.com/v1/"),
      ),
  ).toBe(true);
});
it("denied and stale per-inference approvals dispatch no request; errors contain no raw provider credential detail", async () => {
  for (const stale of [false, true]) {
    const f = await prepared();
    const models = subscriptionModels(
      f.serviceInstance,
      f.serviceInstance.status().configurationRevision,
      async () => {
        if (stale) f.serviceInstance.disconnect();
        else throw new Error(secret);
      },
      f.transport,
    );
    const result = await models.completeSimple(
      models.getModel("openai", "gpt-5-mini")!,
      context,
      { sessionId: "fixture" },
    );
    expect(result.stopReason).toBe(stale ? "aborted" : "error");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(f.calls.filter((c) => c.url.endsWith("/responses"))).toHaveLength(0);
  }
});
it("treats interrupted, incomplete and quota-failed streams as failures and redacts raw errors", async () => {
  for (const reply of [
    () => sse([{ type: "response.created", response: { id: "fixture" } }]),
    () =>
      sse([
        {
          type: "response.incomplete",
          response: { id: "fixture", status: "incomplete", output: [] },
        },
      ]),
    () =>
      Response.json(
        {
          error: {
            message: secret,
            code: "subscription_sharing_usage_limit_exceeded",
          },
        },
        { status: 429 },
      ),
    () =>
      sse([
        {
          type: "error",
          error: { message: secret, code: "subscription_sharing_unavailable" },
        },
      ]),
  ]) {
    const f = await prepared();
    f.modelReply(reply);
    const models = subscriptionModels(
      f.serviceInstance,
      f.serviceInstance.status().configurationRevision,
      async () => {},
      f.transport,
    );
    const result = await models.completeSimple(
      models.getModel("openai", "gpt-5-mini")!,
      context,
      { sessionId: "fixture" },
    );
    expect(result.stopReason).toBe("error");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(f.calls.filter((c) => c.url.endsWith("/responses"))).toHaveLength(1);
  }
});
it("rejects hidden models, changed endpoint/header and expired catalogs before dispatch", async () => {
  const f = await prepared();
  const models = subscriptionModels(
    f.serviceInstance,
    f.serviceInstance.status().configurationRevision,
    async () => {},
    f.transport,
  );
  const model = models.getModel("openai", "gpt-5-mini")!;
  for (const candidate of [
    { ...model, id: "private" },
    { ...model, baseUrl: "https://other.invalid" },
  ]) {
    const result = await models.completeSimple(candidate, context, {
      sessionId: "fixture",
    });
    expect(result.stopReason).toBe("error");
  }
  const changed = await models.completeSimple(model, context, {
    sessionId: "fixture",
    headers: { "X-Route": "changed" },
  });
  expect(changed.stopReason).toBe("error");
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 300001);
  try {
    const result = await models.completeSimple(model, context, {
      sessionId: "fixture",
    });
    expect(result.stopReason).toBe("error");
  } finally {
    vi.restoreAllMocks();
  }
  expect(f.calls.filter((c) => c.url.endsWith("/responses"))).toHaveLength(0);
});
it("permits bounded function history and rejects native unsupported tool/payload fields without advertising capabilities", () => {
  const payload = {
    model: "gpt-5-mini",
    store: false,
    stream: true,
    input: [
      { role: "system", content: "instructions" },
      {
        type: "function_call",
        call_id: "call_1",
        name: "read_file",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "fixture content",
      },
    ],
    tools: [
      {
        type: "function",
        name: "read_file",
        parameters: { type: "object", properties: {} },
      },
    ],
  };
  expect(subscriptionPayload(payload, "gpt-5-mini")).toMatchObject({
    input: [
      { role: "developer" },
      { type: "function_call" },
      { type: "function_call_output" },
    ],
  });
  for (const extra of [
    { background: true },
    { previous_response_id: "remote" },
    { max_output_tokens: 10 },
    { tools: [{ type: "tool_search" }] },
    { tools: [{ type: "computer" }] },
    { tools: [{ type: "web_search" }] },
  ])
    expect(() =>
      subscriptionPayload({ ...payload, ...extra }, "gpt-5-mini"),
    ).toThrow();
});
it("maintained Pi carries approved function declarations and full tool round-trip history", async () => {
  const f = await prepared();
  const models = subscriptionModels(
    f.serviceInstance,
    f.serviceInstance.status().configurationRevision,
    async () => {},
    f.transport,
  );
  const model = models.getModel("openai", "gpt-5-mini")!;
  const previous = await models.completeSimple(model, context, {
    sessionId: "fixture",
  });
  previous.content = [
    {
      type: "toolCall",
      id: "call_fixture",
      name: "read_file",
      arguments: { path: "fixture.txt" },
    },
  ];
  previous.stopReason = "toolUse";
  const result = await models.completeSimple(
    model,
    {
      systemPrompt: "Personal workspace",
      tools: [
        {
          name: "read_file",
          description: "Read approved file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          } as any,
        },
      ],
      messages: [
        ...context.messages,
        previous,
        {
          role: "toolResult",
          toolCallId: "call_fixture",
          toolName: "read_file",
          content: [{ type: "text", text: "synthetic file" }],
          isError: false,
          timestamp: 2,
        },
      ],
    },
    { sessionId: "fixture" },
  );
  expect(result.stopReason).toBe("stop");
  const body = JSON.parse(
    f.calls.filter((c) => c.url.endsWith("/responses")).at(-1)!.init
      .body as string,
  );
  expect(body.tools[0]).toMatchObject({ type: "function", name: "read_file" });
  expect(body.input).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "function_call", name: "read_file" }),
      expect.objectContaining({
        type: "function_call_output",
        output: "synthetic file",
      }),
    ]),
  );
});
it("configuration changes cancel captured provider capabilities", async () => {
  const f = await prepared();
  const binding = f.serviceInstance.providerBinding(
    f.serviceInstance.status().configurationRevision,
  );
  expect(binding.signal.aborted).toBe(false);
  f.serviceInstance.disconnect();
  expect(binding.signal.aborted).toBe(true);
  expect(binding.isCurrent()).toBe(false);
});
