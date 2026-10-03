import { createModels, type Provider } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { privateErrors } from "./provider-errors";
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
    model: {
      id: string;
      provider: string;
      baseUrl: string;
      headers?: Record<string, string | null>;
    },
    apiKey?: string,
    headers?: Record<string, string | null>,
  ) => {
    if (
      model.id !== MODEL_ID ||
      model.provider !== "openai" ||
      model.baseUrl !== "https://api.openai.com/v1"
    )
      throw new Error("Unsupported model configuration");
    if (
      [model.headers, headers].some((value) =>
        Object.keys(value ?? {}).some(
          (name) => name.toLowerCase() === "authorization",
        ),
      )
    )
      throw new Error("Authentication header overrides are unsupported");
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
      requireApiKey(model, options?.apiKey, options?.headers);
      let status: number | undefined;
      const captureFetch: typeof fetch = async (input, init) => {
        const response = await (options?.fetch ?? globalThis.fetch)(
          input,
          init,
        );
        status = response.status;
        return response;
      };
      return privateErrors(
        provider.stream(model as never, context, {
          ...options,
          fetch: captureFetch,
          signal: deadline(options?.signal),
          maxTokens: LIMITS.maxOutputTokens,
          maxRetries: 0,
          timeoutMs: 120000,
        } as never),
        () => status,
      );
    },
    streamSimple: (model, context, options) => {
      requireApiKey(model, options?.apiKey, options?.headers);
      let status: number | undefined;
      const captureFetch: typeof fetch = async (input, init) => {
        const response = await (options?.fetch ?? globalThis.fetch)(
          input,
          init,
        );
        status = response.status;
        return response;
      };
      return privateErrors(
        provider.streamSimple(model as never, context, {
          ...options,
          fetch: captureFetch,
          signal: deadline(options?.signal),
          maxTokens: LIMITS.maxOutputTokens,
          maxRetries: 0,
          timeoutMs: 120000,
        }),
        () => status,
      );
    },
  };
  models.setProvider(bounded);
  return models;
}
