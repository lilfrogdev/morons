import type {
  Model,
  Api,
  TranscriptContext,
  StreamOptions,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { LIMITS } from "../../protocol/index";
import { privateErrors } from "./provider-errors";
import { parseSelection, validZenKey, zenModel } from "./provider-selection";

// Additive adapter: no root, provisioning, UI, credential storage or network
// validation is activated merely by constructing it.
export function zenModels(selection: unknown, key?: string) {
  const selected = parseSelection(selection);
  if (
    !selected ||
    selected.host !== "cloud" ||
    selected.provider !== "opencode" ||
    selected.auth !== "api_key"
  )
    throw new Error("OpenCode Zen cloud selection required");
  const route = zenModel(selected.modelId)!;
  const provider = opencodeProvider();
  const candidate = provider
    .getModels()
    .find(
      (model) =>
        model.id === route.id &&
        model.api === route.api &&
        model.baseUrl === route.baseUrl,
    );
  if (!candidate) throw new Error("Selected model adapter unavailable");
  const canonical = structuredClone(candidate);
  const models = createModels({
    authContext: {
      env: async (name) =>
        name === "OPENCODE_API_KEY" && validZenKey(key) ? key : undefined,
      fileExists: async () => false,
    },
  });
  const wrap =
    (simple: boolean) =>
    (
      model: Model<Api>,
      context: TranscriptContext,
      options?: StreamOptions,
    ) => {
      if (
        model.id !== route.id ||
        model.provider !== "opencode" ||
        model.api !== route.api ||
        model.baseUrl !== route.baseUrl
      )
        throw new Error("Unsupported model configuration");
      if (!validZenKey(key) || options?.apiKey !== key)
        throw new Error("Valid server OpenCode key binding required");
      if (
        Object.keys(model.headers ?? {}).length ||
        Object.keys(options?.headers ?? {}).length
      )
        throw new Error("Header overrides are unsupported");
      if (
        typeof options?.sessionId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(options.sessionId)
      )
        throw new Error("Stable conversation session required");
      let status: number | undefined;
      const captureFetch: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        if (
          request.url !== route.endpoint ||
          request.method !== "POST" ||
          request.headers.get("Authorization") !== `Bearer ${key}`
        )
          throw new Error("Unsupported provider request");
        const response = await (options?.fetch ?? globalThis.fetch)(request, {
          redirect: "error",
        });
        status = response.status;
        return response;
      };
      const bounded = {
        apiKey: key,
        fetch: captureFetch,
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(120000)])
          : AbortSignal.timeout(120000),
        sessionId: options.sessionId,
        headers: {
          "User-Agent": "morons/0.1",
          "x-opencode-session": options.sessionId,
        },
        transport: "sse" as const,
        maxTokens: LIMITS.maxOutputTokens,
        maxRetries: 0,
        timeoutMs: 120000,
      };
      // Caller-supplied metadata, payload hooks and sampling overrides never reach Pi.
      return privateErrors(
        simple
          ? provider.streamSimple(canonical as never, context, bounded)
          : provider.stream(canonical as never, context, bounded as never),
        () => status,
        canonical,
      );
    };
  models.setProvider({
    ...provider,
    auth: { apiKey: provider.auth!.apiKey },
    getModels: () => [structuredClone(canonical)],
    stream: wrap(false),
    streamSimple: wrap(true),
  });
  return models;
}
