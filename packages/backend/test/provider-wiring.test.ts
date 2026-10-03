import { expect, it } from "vitest";
import {
  configuredSelection,
  publicConfiguration,
  selectedReadiness,
} from "../src/provider-configuration";

it("preserves explicit legacy settings while new bindings require provider/auth/model", () => {
  expect(configuredSelection({ OPENAI_API_KEY: "sk-fixture" })).toEqual({
    host: "cloud",
    provider: "openai",
    auth: "api_key",
    modelId: "gpt-5-mini",
  });
  expect(
    configuredSelection({ PROVIDER_ID: "opencode", AUTH_MODE: "api_key" }),
  ).toBeUndefined();
  expect(
    selectedReadiness({
      PROVIDER_ID: "opencode",
      AUTH_MODE: "api_key",
      MODEL_ID: "kimi-k3",
      OPENAI_API_KEY: "sk-wrong-slot",
    }),
  ).toBe("missing_credential");
  expect(
    selectedReadiness({
      PROVIDER_ID: "openai",
      AUTH_MODE: "api_key",
      MODEL_ID: "gpt-5-mini",
      OPENCODE_API_KEY: "fixture-key-wrong-slot",
    }),
  ).toBe("missing_credential");
});
it("publishes only allowlisted selection/readiness without credentials, subscription inference or verification claims", () => {
  const config = publicConfiguration({
    PROVIDER_ID: "opencode",
    AUTH_MODE: "api_key",
    MODEL_ID: "kimi-k3",
    OPENCODE_API_KEY: "fixture-zen-key-never-live",
  });
  expect(config).toMatchObject({
    version: 2,
    selection: {
      host: "cloud",
      provider: "opencode",
      auth: "api_key",
      modelId: "kimi-k3",
    },
    providerEndpoint: "https://opencode.ai/zen/v1/chat/completions",
    secretBinding: "OPENCODE_API_KEY",
    readiness: "ready",
    verification: "not_verified",
  });
  expect(JSON.stringify(config)).not.toContain("fixture-zen-key");
  for (const PROVIDER_ID of ["opencode-go", "secret-provider"]) {
    expect(
      publicConfiguration({
        PROVIDER_ID,
        AUTH_MODE: "api_key",
        MODEL_ID: "kimi-k3",
        OPENCODE_API_KEY: "fixture-zen-key",
      }),
    ).toMatchObject({
      version: 2,
      selection: null,
      providerEndpoint: null,
      secretBinding: null,
      readiness: "unsupported_model",
    });
  }
  expect(
    selectedReadiness({
      PROVIDER_ID: "openai",
      AUTH_MODE: "chatgpt_subscription",
      MODEL_ID: "gpt-5-mini",
      OPENAI_API_KEY: "sk-fixture",
    }),
  ).toBe("unsupported_model");
});
