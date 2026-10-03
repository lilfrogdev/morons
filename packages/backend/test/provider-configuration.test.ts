import { expect, it } from "vitest";
import {
  publicConfiguration,
  readiness,
  validApiKey,
} from "../src/provider-configuration";

it("allows only bounded API-key syntax, never subscription credentials", () => {
  for (const key of [
    undefined,
    null,
    {},
    "",
    "sk-",
    "eyJhbGciOi",
    '{"access":"token"}',
    "sk-fixture\n",
    "sk-fixture bearer",
    "sk-é",
    "sk-" + "a".repeat(4094),
  ])
    expect(validApiKey(key)).toBe(false);
  expect(validApiKey("sk-proj-fixture_123")).toBe(true);
  expect(validApiKey("sk-" + "a".repeat(4093))).toBe(true);
});

it("reports missing and invalid bindings and strictly validates model choice", () => {
  expect(readiness({})).toBe("missing_credential");
  expect(readiness({ OPENAI_API_KEY: "oauth-fixture" })).toBe(
    "invalid_credential",
  );
  expect(
    readiness({ OPENAI_API_KEY: "sk-fixture", MODEL_ID: "gpt-5-mini" }),
  ).toBe("ready");
  expect(readiness({ OPENAI_API_KEY: "sk-fixture", MODEL_ID: "" })).toBe(
    "unsupported_model",
  );
});

it("public readiness contains only curated fields even for hostile bindings", () => {
  const raw = "sk-fixture-private";
  const json = JSON.stringify(
    publicConfiguration({
      OPENAI_API_KEY: raw,
      MODEL_ID: "secret-hostile-model",
    }),
  );
  expect(json).not.toContain(raw);
  expect(json).not.toContain("secret-hostile-model");
  expect(JSON.parse(json)).toMatchObject({
    readiness: "unsupported_model",
    modelId: "gpt-5-mini",
    verification: "not_verified",
  });
  expect(publicConfiguration({ OPENAI_API_KEY: raw }, true).readiness).toBe(
    "fixture",
  );
});
