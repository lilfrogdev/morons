import type {
  Api,
  Model,
  TranscriptContext,
  StreamOptions,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { LocalAuthService } from "./local-service";
import { subscriptionPayload } from "./pi-payload";
import { buildSubscriptionRequest } from "./subscription-request";
import { privateErrors } from "./pi-events";
import { AuthError, type Transport } from "./index";
const ENDPOINT = "https://api.openai.com/v1/responses";
// Pi uses this non-secret adapter credential internally; it is NEVER transmitted.
// An sk- prefix explicitly avoids Pi's credential-shape subscription heuristic.
const INTERNAL = "sk-morons-capability-never-a-provider-credential";
export interface ModelCallIntent {
  action: "subscription_inference";
  endpoint: typeof ENDPOINT;
  provider: "openai";
  model: string;
  billing: "subscription";
  executionHost: "local";
  configurationRevision: number;
  sessionId: string;
  sha256: string;
  inputBytes: number;
  // Non-credential request data for exact user review, kept off status/log DTOs.
  requestBody: string;
}
export type ModelCallApproval = (
  intent: ModelCallIntent,
  signal: AbortSignal,
) => Promise<void>;
export function subscriptionModels(
  service: LocalAuthService,
  revision: number,
  approve: ModelCallApproval,
  transport: Transport,
) {
  const binding = service.providerBinding(revision),
    provider = openaiProvider();
  const model: Model<"openai-responses"> = structuredClone(
    provider
      .getModels()
      .find((model) => model.id === binding.selectedModelId) ?? {
      id: binding.selectedModelId,
      name: binding.selectedModelId,
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: false,
      input: ["text"],
      contextWindow: 16384,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  );
  // Account catalog validates choice. Curated Pi metadata supplies compatibility
  // when known; unknown visible models use conservative text-only capabilities.
  delete model.headers;
  delete model.samplingParams;
  model.compat = { ...model.compat, supportsMaxOutputTokens: false };
  // Subscription billing has no per-token API price; DTOs carry billing explicitly.
  model.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const models = createModels({
    authContext: {
      env: async (name) => (name === "OPENAI_API_KEY" ? INTERNAL : undefined),
      fileExists: async () => false,
    },
  });
  const wrap =
    (simple: boolean) =>
    (
      candidate: Model<Api>,
      context: TranscriptContext,
      options?: StreamOptions,
    ) => {
      if (
        candidate.id !== model.id ||
        candidate.provider !== "openai" ||
        candidate.api !== "openai-responses" ||
        candidate.baseUrl !== model.baseUrl ||
        !binding.isCurrent() ||
        !options?.sessionId ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(options.sessionId)
      )
        throw new AuthError("invalid_attempt");
      if (
        options.apiKey !== INTERNAL ||
        Object.keys(options.headers ?? {}).length ||
        options.onPayload ||
        options.samplingParams ||
        (options.env !== undefined &&
          (Object.keys(options.env).join(",") !== "OPENAI_API_KEY" ||
            options.env.OPENAI_API_KEY !== INTERNAL))
      )
        throw new AuthError("invalid_attempt");
      // Validates branded catalog freshness/account/model before any request.
      buildSubscriptionRequest({
        catalog: binding.catalog,
        identity: binding.identity,
        model: model.id,
        instructions: "Morons",
        input: [{ role: "user", content: "catalog validation" }],
      });
      const signal = options.signal
        ? AbortSignal.any([
            options.signal,
            binding.signal,
            AbortSignal.timeout(120000),
          ])
        : AbortSignal.any([binding.signal, AbortSignal.timeout(120000)]);
      let status: number | undefined;
      let dispatched = false;
      const wireFetch: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        if (
          dispatched ||
          request.url !== ENDPOINT ||
          request.method !== "POST" ||
          request.headers.get("authorization") !== `Bearer ${INTERNAL}` ||
          !binding.isCurrent()
        )
          throw new AuthError("invalid_attempt");
        const source = await request.text();
        if (Buffer.byteLength(source) > 262144)
          throw new AuthError("invalid_attempt");
        const payload = subscriptionPayload(JSON.parse(source), model.id),
          body = JSON.stringify(payload);
        const digest = Buffer.from(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)),
        ).toString("hex");
        await approve(
          {
            action: "subscription_inference",
            endpoint: ENDPOINT,
            provider: "openai",
            model: model.id,
            billing: "subscription",
            executionHost: "local",
            configurationRevision: revision,
            sessionId: options.sessionId!,
            sha256: digest,
            inputBytes: Buffer.byteLength(body),
            requestBody: body,
          },
          signal,
        );
        signal.throwIfAborted();
        if (!binding.isCurrent()) throw new AuthError("invalid_attempt");
        dispatched = true;
        return binding.session.withAccessToken(async (token, identity) => {
          signal.throwIfAborted();
          if (
            !binding.isCurrent() ||
            identity.subject !== binding.identity.subject ||
            identity.clientId !== binding.identity.clientId
          )
            throw new AuthError("invalid_attempt");
          const response = await transport(ENDPOINT, {
            method: "POST",
            body,
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              "User-Agent": "morons/0.1",
            },
            redirect: "error",
            signal,
          });
          status = response.status;
          if (
            (response.status >= 300 && response.status < 400) ||
            !response.body
          )
            throw new AuthError("validation_failed");
          let bytes = 0,
            buffer = "",
            completed = false;
          const decoder = new TextDecoder();
          const consume = (chunk: Uint8Array) => {
            bytes += chunk.byteLength;
            if (bytes > 1048576) throw new AuthError("validation_failed");
            buffer += decoder.decode(chunk, { stream: true });
            if (Buffer.byteLength(buffer) > 131072)
              throw new AuthError("validation_failed");
            while (true) {
              const match = /\r?\n\r?\n/.exec(buffer);
              if (!match) break;
              const frame = buffer.slice(0, match.index);
              buffer = buffer.slice(match.index + match[0].length);
              const data = frame
                .split(/\r?\n/)
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trimStart())
                .join("\n");
              if (data && data !== "[DONE]") {
                const event = JSON.parse(data);
                if (
                  ["response.incomplete", "response.failed", "error"].includes(
                    event.type,
                  )
                )
                  throw new AuthError("validation_failed");
                if (event.type === "response.completed") {
                  if (completed || event.response?.status !== "completed")
                    throw new AuthError("validation_failed");
                  completed = true;
                }
              }
            }
          };
          const boundedBody = response.body.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                signal.throwIfAborted();
                if (response.ok) consume(chunk);
                else {
                  bytes += chunk.byteLength;
                  if (bytes > 65536) throw new AuthError("validation_failed");
                }
                controller.enqueue(chunk);
              },
              flush() {
                signal.throwIfAborted();
                if (response.ok && !completed)
                  throw new AuthError("validation_failed");
              },
            }),
            { signal },
          );
          return new Response(boundedBody, {
            status: response.status,
            headers: response.headers,
          });
        }, signal);
      };
      const bounded = {
        apiKey: INTERNAL,
        fetch: wireFetch,
        signal,
        sessionId: options.sessionId,
        transport: "sse" as const,
        cacheRetention: "none" as const,
        maxRetries: 0,
        timeoutMs: 120000,
      };
      return privateErrors(
        simple
          ? provider.streamSimple(structuredClone(model), context, bounded)
          : provider.stream(structuredClone(model), context, bounded),
        () => status,
        model,
      );
    };
  models.setProvider({
    ...provider,
    auth: { apiKey: provider.auth.apiKey! },
    getModels: () => [structuredClone(model)],
    stream: wrap(false),
    streamSimple: wrap(true),
  });
  return models;
}
