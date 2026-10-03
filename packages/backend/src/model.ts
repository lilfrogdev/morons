import { createModels, type Provider } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { LIMITS } from "../../protocol/index";
import { MODEL_ID, validApiKey } from "./provider-configuration";
export { validApiKey } from "./provider-configuration";
export function productionModels(key?: string) {
  const models = createModels({
    authContext: {
      env: async (name) =>
        name === "OPENAI_API_KEY" && validApiKey(key) ? key : undefined,
      fileExists: async () => false,
    },
  });
  const provider = openaiProvider();
  const deadline = (signal?: AbortSignal) =>
    signal
      ? AbortSignal.any([signal, AbortSignal.timeout(120000)])
      : AbortSignal.timeout(120000);
  const requireApiKey = (
    model: { id: string; provider: string; baseUrl: string },
    apiKey?: string,
  ) => {
    if (
      model.id !== MODEL_ID ||
      model.provider !== "openai" ||
      model.baseUrl !== "https://api.openai.com/v1"
    )
      throw new Error("Unsupported model configuration");
    if (!validApiKey(key) || apiKey !== key)
      throw new Error("Valid server API-key binding required");
  };
  const bounded: Provider = {
    ...provider,
    auth: { apiKey: provider.auth!.apiKey },
    // Curated API-key model; this OpenAI Responses model supports max_output_tokens.
    getModels: () =>
      provider.getModels().filter((model) => model.id === MODEL_ID),
    stream: (model, context, options) => {
      requireApiKey(model, options?.apiKey);
      return provider.stream(model as never, context, {
        ...options,
        signal: deadline(options?.signal),
        maxTokens: LIMITS.maxOutputTokens,
        maxRetries: 0,
        timeoutMs: 120000,
      } as never);
    },
    streamSimple: (model, context, options) => {
      requireApiKey(model, options?.apiKey);
      return provider.streamSimple(model as never, context, {
        ...options,
        signal: deadline(options?.signal),
        maxTokens: LIMITS.maxOutputTokens,
        maxRetries: 0,
        timeoutMs: 120000,
      });
    },
  };
  models.setProvider(bounded);
  return models;
}
