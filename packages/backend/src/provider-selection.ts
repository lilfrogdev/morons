// Deployment selection is explicit. Credentials never decide provider or host.
// These tuples are the supported intersection of Pi 1.0.0 and Zen's catalog.
export const ZEN_MODELS = Object.freeze([
  Object.freeze({
    id: "gpt-6.1-sol",
    name: "GPT 6.1 Sol",
    api: "openai-responses",
    baseUrl: "https://opencode.ai/zen/v1",
    endpoint: "https://opencode.ai/zen/v1/responses",
  }),
  Object.freeze({
    id: "kimi-k3",
    name: "Kimi K3",
    api: "openai-completions",
    baseUrl: "https://opencode.ai/zen/v1",
    endpoint: "https://opencode.ai/zen/v1/chat/completions",
  }),
  Object.freeze({
    id: "minimax-m3",
    name: "MiniMax M3",
    api: "openai-completions",
    baseUrl: "https://opencode.ai/zen/v1",
    endpoint: "https://opencode.ai/zen/v1/chat/completions",
  }),
] as const);
export type ZenModelId = (typeof ZEN_MODELS)[number]["id"];
export type ProviderSelection =
  | {
      host: "cloud";
      provider: "openai";
      auth: "api_key";
      modelId: "gpt-5-mini";
    }
  | {
      host: "cloud";
      provider: "opencode";
      auth: "api_key";
      modelId: ZenModelId;
    }
  | {
      host: "local";
      provider: "openai";
      auth: "chatgpt_subscription";
      modelId: string;
    };

export function zenModel(id: unknown) {
  return ZEN_MODELS.find((model) => model.id === id);
}

// OpenCode does not document an sk- prefix. Accept a bounded bearer-token
// alphabet, rejecting structured OAuth credentials and header injection.
export function validZenKey(key: unknown): key is string {
  return typeof key === "string" && /^[A-Za-z0-9_-]{16,4096}$/.test(key);
}

export function parseSelection(value: unknown): ProviderSelection | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(",") !== "auth,host,modelId,provider") return;
  if (v.host === "cloud" && v.auth === "api_key") {
    if (v.provider === "openai" && v.modelId === "gpt-5-mini")
      return {
        host: "cloud",
        provider: "openai",
        auth: "api_key",
        modelId: "gpt-5-mini",
      };
    const model = zenModel(v.modelId);
    if (v.provider === "opencode" && model)
      return {
        host: "cloud",
        provider: "opencode",
        auth: "api_key",
        modelId: model.id,
      };
  }
  // Local account catalog validation is a separate gate; parsing cannot authorize
  // inference. There is deliberately no cloud subscription or Go fallback.
  if (
    v.host === "local" &&
    v.provider === "openai" &&
    v.auth === "chatgpt_subscription" &&
    typeof v.modelId === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(v.modelId)
  )
    return {
      host: "local",
      provider: "openai",
      auth: "chatgpt_subscription",
      modelId: v.modelId,
    };
}

export const PROVIDER_OPTIONS = Object.freeze([
  Object.freeze({
    host: "cloud",
    provider: "opencode",
    auth: "api_key",
    label: "OpenCode Zen",
    billing: "pay_per_request",
    implementation: "adapter_only",
  }),
  Object.freeze({
    host: "local",
    provider: "openai",
    auth: "chatgpt_subscription",
    label: "ChatGPT subscription",
    billing: "subscription",
    implementation: "auth_pending",
  }),
  Object.freeze({
    host: "cloud",
    provider: "opencode-go",
    auth: "api_key",
    label: "OpenCode Go",
    billing: "subscription",
    implementation: "scope_unverified",
  }),
] as const);

// Public capability metadata only; not connection verification or send approval.
export function selectionConfiguration(value: unknown) {
  const selection = parseSelection(value);
  if (!selection)
    return {
      version: 1,
      readiness: "invalid_selection",
      verification: "not_verified",
    } as const;
  return {
    version: 1 as const,
    ...selection,
    readiness:
      selection.auth === "chatgpt_subscription"
        ? ("auth_pending" as const)
        : ("credential_required" as const),
    verification: "not_verified" as const,
  };
}
