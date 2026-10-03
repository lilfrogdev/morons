import { expect, it } from "vitest";
import {
  parseSelection,
  selectionConfiguration,
  validZenKey,
  ZEN_MODELS,
} from "../src/provider-selection";
import { zenModels } from "../src/zen-model";
const key = "fixture-zen-secret-never-live";
const selection = (modelId: string) => ({
  host: "cloud",
  provider: "opencode",
  auth: "api_key",
  modelId,
});
const context = {
  messages: [{ role: "user" as const, content: "fixture", timestamp: 1 }],
};

it("requires explicit provider, auth, host and allowlisted model without a default", () => {
  for (const value of [
    undefined,
    {},
    selection("unknown"),
    { ...selection("gpt-6.1-sol"), host: "local" },
    { ...selection("gpt-6.1-sol"), auth: "chatgpt_subscription" },
    { ...selection("gpt-6.1-sol"), provider: "opencode-go" },
    { ...selection("gpt-6.1-sol"), key },
  ]) {
    expect(parseSelection(value)).toBeUndefined();
    expect(JSON.stringify(selectionConfiguration(value))).not.toContain(key);
    expect(() => zenModels(value, key)).toThrow();
  }
  const local = {
    host: "local",
    provider: "openai",
    auth: "chatgpt_subscription",
    modelId: "account-model",
  };
  expect(selectionConfiguration(local).readiness).toBe("auth_pending");
  expect(() => zenModels(local, key)).toThrow();
  expect(parseSelection({ ...local, host: "cloud" })).toBeUndefined();
  expect(selectionConfiguration(selection("kimi-k3")).readiness).toBe(
    "credential_required",
  );
});

it("accepts bounded Zen bearer syntax without OpenAI prefix inference", () => {
  expect(validZenKey(key)).toBe(true);
  for (const value of [
    undefined,
    "",
    "short",
    "x".repeat(4097),
    `${key}\r\nAuthorization: injected`,
    ` ${key}`,
    JSON.stringify({ access: key }),
    "header.payload.signature",
  ])
    expect(validZenKey(value)).toBe(false);
});

it("uses each exact Zen tuple, caps output and suppresses retries and payload overrides", async () => {
  for (const route of ZEN_MODELS) {
    for (const simple of [true, false]) {
      const models = zenModels(selection(route.id), key);
      expect(models.getProvider("opencode")!.auth!.oauth).toBeUndefined();
      expect(
        models.getModel(
          "opencode",
          route.id === "kimi-k3" ? "gpt-6.1-sol" : "kimi-k3",
        ),
      ).toBeUndefined();
      const requests: {
        url: string;
        body: any;
        auth: string | null;
        session: string | null;
        ua: string | null;
        redirect?: RequestRedirect;
      }[] = [];
      const options = {
        sessionId: "fixture-conversation",
        maxTokens: 90000,
        maxRetries: 5,
        samplingParams: {
          max_output_tokens: 90000,
          max_tokens: 90000,
          model: "unknown",
        },
        onPayload: () => {
          throw new Error("Caller hook must not run");
        },
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          requests.push({
            url: request.url,
            body: await request.json(),
            auth: request.headers.get("Authorization"),
            session: request.headers.get("x-opencode-session"),
            ua: request.headers.get("User-Agent"),
            redirect: init?.redirect,
          });
          return Response.json(
            { error: { message: `diagnostic ${key}`, type: "server_error" } },
            { status: 503 },
          );
        },
      };
      const model = models.getModel("opencode", route.id)!;
      model.samplingParams = {
        max_output_tokens: 90000,
        max_tokens: 90000,
        model: "unknown",
      };
      const stream = simple
        ? models.streamSimple(model, context, options)
        : models.stream(model, context, options);
      const events = [];
      for await (const event of stream) events.push(event);
      const result = await stream.result();
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toBe("Provider request failed (HTTP 503).");
      expect(JSON.stringify(events)).not.toContain(key);
      expect(JSON.stringify(result)).not.toContain(key);
      expect(result.provider).toBe("opencode");
      expect(result.model).toBe(route.id);
      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe(route.endpoint);
      expect(requests[0].auth).toBe(`Bearer ${key}`);
      expect(requests[0].session).toBe("fixture-conversation");
      expect(requests[0].ua).toBe("morons/0.1");
      expect(requests[0].redirect).toBe("error");
      expect(requests[0].body.model).toBe(route.id);
      expect(
        requests[0].body.max_output_tokens ??
          requests[0].body.max_tokens ??
          requests[0].body.max_completion_tokens,
      ).toBe(4096);
    }
  }
});

it("rejects credential, destination, auth header and missing session overrides before HTTP", async () => {
  let calls = 0;
  for (const binding of [undefined, "header.payload.signature", key]) {
    const models = zenModels(selection("gpt-6.1-sol"), binding);
    const original = models.getModel("opencode", "gpt-6.1-sol")!;
    for (const change of [
      { model: original, options: { apiKey: "different-fixture-key" } },
      {
        model: { ...original, baseUrl: "https://fixture.invalid" },
        options: {},
      },
      { model: { ...original, provider: "openai" }, options: {} },
      {
        model: { ...original, api: "openai-completions" as const },
        options: {},
      },
      {
        model: original,
        options: { headers: { authorization: "Bearer fixture" } },
      },
      { model: original, options: { sessionId: undefined } },
    ]) {
      const stream = models.streamSimple(change.model, context, {
        sessionId: "fixture",
        ...change.options,
        fetch: async () => {
          calls++;
          return Response.json({});
        },
      });
      expect((await stream.result()).stopReason).toBe("error");
    }
  }
  expect(calls).toBe(0);
});

it("propagates cancellation and redacts thrown transport diagnostics", async () => {
  const models = zenModels(selection("kimi-k3"), key);
  const model = models.getModel("opencode", "kimi-k3")!;
  const controller = new AbortController();
  let started!: (signal: AbortSignal) => void;
  const dispatched = new Promise<AbortSignal>((resolve) => {
    started = resolve;
  });
  const stream = models.streamSimple(model, context, {
    sessionId: "fixture",
    signal: controller.signal,
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
  });
  const signal = await dispatched;
  controller.abort();
  expect((await stream.result()).stopReason).toBe("aborted");
  expect(signal.aborted).toBe(true);
  const failure = models.streamSimple(model, context, {
    sessionId: "fixture",
    fetch: async () => {
      throw new Error(`private ${key}`);
    },
  });
  const events = [];
  for await (const event of failure) events.push(event);
  expect(JSON.stringify(events)).not.toContain(key);
  expect((await failure.result()).errorMessage).toBe(
    "Provider request failed.",
  );
});

it("streams a completed synthetic Zen reply through Pi", async () => {
  const models = zenModels(selection("kimi-k3"), key);
  const stream = models.streamSimple(
    models.getModel("opencode", "kimi-k3")!,
    context,
    {
      sessionId: "fixture",
      fetch: async () =>
        new Response(
          [
            {
              id: "fixture",
              object: "chat.completion.chunk",
              created: 1,
              model: "kimi-k3",
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: "Fixture reply" },
                  finish_reason: null,
                },
              ],
            },
            {
              id: "fixture",
              object: "chat.completion.chunk",
              created: 1,
              model: "kimi-k3",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            },
          ]
            .map((part) => `data: ${JSON.stringify(part)}\n\n`)
            .join("") + "data: [DONE]\n\n",
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    },
  );
  const events = [];
  for await (const event of stream) events.push(event);
  const result = await stream.result();
  expect(result.stopReason).toBe("stop");
  expect(result.content).toEqual([{ type: "text", text: "Fixture reply" }]);
  expect(events.some((event) => event.type === "text_delta")).toBe(true);
});
