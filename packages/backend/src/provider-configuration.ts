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
}

// Only API-key syntax reaches Pi. In particular JSON, JWTs, and subscription
// credentials cannot trigger Pi's non-sk- ChatGPT sign-in heuristic.
export function validApiKey(key: unknown): key is string {
  return typeof key === "string" && /^sk-[A-Za-z0-9_-]{1,4093}$/.test(key);
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
