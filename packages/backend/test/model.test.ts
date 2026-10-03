import { expect, it } from "vitest";
import { productionModels } from "../src/model";
it("caps real provider payloads and disables provider retries with a mock HTTP transport", async () => {
  const models = productionModels("sk-fixture-server-key");
  const model = models.getModel("openai", "gpt-5-mini")!;
  const requests: { body: any; auth: string | null; url: string }[] = [];
  const stream = models.streamSimple(
    model,
    { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
    {
      maxTokens: 90000,
      maxRetries: 5,
      transport: "sse",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push({
          body: await request.json(),
          auth: request.headers.get("Authorization"),
          url: request.url,
        });
        return Response.json(
          {
            error: {
              message: "Mock provider unavailable",
              type: "server_error",
            },
          },
          { status: 503 },
        );
      },
    },
  );
  const result = await stream.result();
  expect(result.stopReason).toBe("error");
  expect(requests).toHaveLength(1);
  expect(requests[0].body.max_output_tokens).toBe(4096);
  expect(requests[0].body.tools ?? []).toEqual([]);
  expect(requests[0].auth).toBe("Bearer sk-fixture-server-key");
  expect(requests[0].url).toBe("https://api.openai.com/v1/responses");
});

it("propagates exact task cancellation to real provider HTTP requests", async () => {
  const models = productionModels("sk-fixture-server-key");
  const model = models.getModel("openai", "gpt-5-mini")!;
  const controller = new AbortController();
  let started: (signal: AbortSignal) => void;
  const dispatched = new Promise<AbortSignal>((resolve) => {
    started = resolve;
  });
  const stream = models.streamSimple(
    model,
    { messages: [{ role: "user", content: "slow", timestamp: Date.now() }] },
    {
      signal: controller.signal,
      transport: "sse",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        started(request.signal);
        return new Promise((_, reject) =>
          request.signal.addEventListener(
            "abort",
            () => reject(new DOMException("Cancelled", "AbortError")),
            { once: true },
          ),
        );
      },
    },
  );
  const signal = await dispatched;
  expect(signal.aborted).toBe(false);
  controller.abort();
  expect((await stream.result()).stopReason).toBe("aborted");
  expect(signal.aborted).toBe(true);
});

it("rejects subscription credentials, auth overrides, and custom endpoints before HTTP", async () => {
  let calls = 0;
  for (const [binding, override, custom] of [
    ["oauth-fixture", undefined, false],
    ["sk-fixture-server-key", "oauth-fixture", false],
    ["sk-fixture-server-key", "sk-other-fixture", false],
    ["sk-fixture-server-key", undefined, true],
  ] as const) {
    const models = productionModels(binding);
    expect(models.getProvider("openai")!.auth!.oauth).toBeUndefined();
    expect(models.getModel("openai", "gpt-5")).toBeUndefined();
    const allowed = models.getModel("openai", "gpt-5-mini")!;
    const model = custom
      ? { ...allowed, baseUrl: "https://fixture.invalid" }
      : allowed;
    const stream = models.streamSimple(
      model,
      { messages: [{ role: "user", content: "fixture", timestamp: 1 }] },
      {
        ...(override ? { apiKey: override } : {}),
        fetch: async () => {
          calls++;
          return Response.json({});
        },
      },
    );
    expect((await stream.result()).stopReason).toBe("error");
  }
  expect(calls).toBe(0);
});

it("rejects auth header overrides before Pi can dispatch a subscription bearer", async () => {
  const models = productionModels("sk-fixture-server-key");
  const model = models.getModel("openai", "gpt-5-mini")!;
  let calls = 0;
  for (const header of ["Authorization", "authorization", "AUTHORIZATION"]) {
    const stream = models.streamSimple(
      model,
      { messages: [{ role: "user", content: "fixture", timestamp: 1 }] },
      {
        headers: { [header]: "Bearer fixture-subscription-token" },
        fetch: async () => {
          calls++;
          return Response.json({});
        },
      },
    );
    expect((await stream.result()).stopReason).toBe("error");
  }
  expect(calls).toBe(0);
});

it("sanitizes provider errors before events or internal transcript results retain a key", async () => {
  const key = "sk-fixture-private-never-live";
  const models = productionModels(key);
  const stream = models.streamSimple(
    models.getModel("openai", "gpt-5-mini")!,
    {
      messages: [{ role: "user", content: "fixture", timestamp: 1 }],
    },
    {
      fetch: async () =>
        Response.json(
          {
            error: {
              message: `Provider diagnostic contains ${key}`,
              type: "server_error",
            },
          },
          { status: 503 },
        ),
    },
  );
  const events = [];
  for await (const event of stream) events.push(event);
  const result = await stream.result();
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toBe("Provider request failed (HTTP 503).");
  expect(JSON.stringify(events)).not.toContain(key);
  expect(JSON.stringify(result)).not.toContain(key);
  expect(JSON.stringify(events)).not.toContain("Provider diagnostic");
});

it("sanitizes thrown and streaming error chunks, including retained partial metadata", async () => {
  const key = "sk-fixture-private-never-live";
  for (const transport of [
    async () => {
      throw new Error(`Transport diagnostic ${key}`);
    },
    async () =>
      new Response(
        `data: ${JSON.stringify({ type: "error", code: "fixture", message: `Chunk diagnostic ${key}` })}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      ),
    async () =>
      new Response(
        `data: ${JSON.stringify({ type: "response.failed", response: { status: key, id: key, error: { code: "fixture", message: key } } })}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      ),
  ]) {
    const models = productionModels(key);
    const stream = models.streamSimple(
      models.getModel("openai", "gpt-5-mini")!,
      { messages: [{ role: "user", content: "fixture", timestamp: 1 }] },
      { fetch: transport },
    );
    const events = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("Provider request failed.");
    expect(JSON.stringify(events)).not.toContain(key);
    expect(JSON.stringify(result)).not.toContain(key);
  }
});
