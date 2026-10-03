import { parseSelection, validZenKey, zenModel } from "./provider-selection";
export const MODEL_ID = "gpt-5-mini" as const;
export type Readiness =
  | "missing_credential"
  | "invalid_credential"
  | "unsupported_model"
  | "ready"
  | "fixture";

export interface ProviderBindings {
  OPENAI_API_KEY?: string;
  MODEL_ID?: string;
  PROVIDER_ID?: string;
  AUTH_MODE?: string;
  OPENCODE_API_KEY?: string;
}

// Only API-key syntax reaches Pi. In particular JSON, JWTs, and subscription
// credentials cannot trigger Pi's non-sk- ChatGPT sign-in heuristic.
export function validApiKey(key: unknown): key is string {
  return typeof key === "string" && /^sk-[A-Za-z0-9_-]{1,4093}$/.test(key);
}

export function configuredSelection(bindings: ProviderBindings) {
  const legacy =
    bindings.PROVIDER_ID === undefined && bindings.AUTH_MODE === undefined;
  const selected = parseSelection({
    host: "cloud",
    provider: legacy ? "openai" : bindings.PROVIDER_ID,
    auth: legacy ? "api_key" : bindings.AUTH_MODE,
    modelId: legacy ? (bindings.MODEL_ID ?? MODEL_ID) : bindings.MODEL_ID,
  });
  return selected?.host === "cloud" ? selected : undefined;
}
export function selectedReadiness(bindings: ProviderBindings): Readiness {
  const selection = configuredSelection(bindings);
  if (!selection) return "unsupported_model";
  const key =
    selection.provider === "opencode"
      ? bindings.OPENCODE_API_KEY
      : bindings.OPENAI_API_KEY;
  if (!key) return "missing_credential";
  return (
    selection.provider === "opencode" ? validZenKey(key) : validApiKey(key)
  )
    ? "ready"
    : "invalid_credential";
}

export function readiness(bindings: ProviderBindings): Readiness {
  if (bindings.MODEL_ID !== undefined && bindings.MODEL_ID !== MODEL_ID)
    return "unsupported_model";
  if (!bindings.OPENAI_API_KEY) return "missing_credential";
  return validApiKey(bindings.OPENAI_API_KEY) ? "ready" : "invalid_credential";
}

// Deliberately constructed from constants: no raw key, model id, provider
// error, environment object, or account identifier can enter public JSON.
export function publicConfiguration(
  bindings: ProviderBindings,
  fixture = false,
) {
  if (bindings.PROVIDER_ID !== undefined || bindings.AUTH_MODE !== undefined) {
    const selection = configuredSelection(bindings);
    return {
      version: 2 as const,
      selection: selection ?? null,
      providerEndpoint: selection
        ? selection.provider === "opencode"
          ? zenModel(selection.modelId)!.endpoint
          : "https://api.openai.com/v1/responses"
        : null,
      secretBinding: selection
        ? selection.provider === "opencode"
          ? "OPENCODE_API_KEY"
          : "OPENAI_API_KEY"
        : null,
      readiness: fixture ? ("fixture" as const) : selectedReadiness(bindings),
      verification: "not_verified" as const,
    };
  }
  return {
    version: 1 as const,
    provider: "openai" as const,
    modelId: MODEL_ID,
    authMode: "api_key" as const,
    readiness: fixture ? ("fixture" as const) : readiness(bindings),
    subscription: {
      openai: "unsupported" as const,
      opencode: "unsupported" as const,
    },
    verification: "not_verified" as const,
  };
}
