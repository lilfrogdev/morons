import { createModels, type Provider } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { LIMITS } from "../../protocol/index";
export function validApiKey(key?: string): boolean {
  return Boolean(
    key?.startsWith("sk-") && key.length <= 4096 && !/\s/.test(key),
  );
}
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
  const bounded: Provider = {
    ...provider,
    // Curated API-key model; this OpenAI Responses model supports max_output_tokens.
    getModels: () =>
      provider.getModels().filter((model) => model.id === "gpt-5-mini"),
    stream: (model, context, options) =>
      provider.stream(model as never, context, {
        ...options,
        signal: deadline(options?.signal),
        maxTokens: LIMITS.maxOutputTokens,
        maxRetries: 0,
        timeoutMs: 120000,
      } as never),
    streamSimple: (model, context, options) =>
      provider.streamSimple(model as never, context, {
        ...options,
        signal: deadline(options?.signal),
        maxTokens: LIMITS.maxOutputTokens,
        maxRetries: 0,
        timeoutMs: 120000,
      }),
  };
  models.setProvider(bounded);
  return models;
}
