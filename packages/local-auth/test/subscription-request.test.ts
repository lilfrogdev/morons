import { afterEach, expect, it, vi } from "vitest";
import {
  buildSubscriptionRequest,
  parseCatalog,
} from "../src/subscription-request";
const identity = {
  issuer: "https://auth.openai.com",
  subject: "fixture-user",
  clientId: "fixture_client",
};
const body = {
  models: [
    { slug: "fixture-visible", display_name: "Visible", visibility: "list" },
    { slug: "fixture-hidden", display_name: "Hidden", visibility: "hidden" },
  ],
};
function options() {
  return {
    catalog: parseCatalog(body, identity),
    identity,
    model: "fixture-visible",
    instructions: "Synthetic instructions",
    input: [{ role: "user" as const, content: "Synthetic question" }],
  };
}
afterEach(() => vi.useRealTimers());
it("preserves visible model order and emits only supported fields", () => {
  const setup = options();
  expect(setup.catalog.models.map((model) => model.slug)).toEqual([
    "fixture-visible",
  ]);
  expect(buildSubscriptionRequest(setup)).toEqual({
    model: setup.model,
    instructions: setup.instructions,
    input: setup.input,
    store: false,
    stream: true,
  });
});
it("rejects hidden, arbitrary and account-switched models", () => {
  const setup = options();
  for (const patch of [
    { model: "fixture-hidden" },
    { model: "arbitrary" },
    { identity: { ...identity, subject: "other" } },
    { identity: { ...identity, clientId: "other" } },
  ])
    expect(() => buildSubscriptionRequest({ ...setup, ...patch })).toThrow(
      "validation failed",
    );
});
it("rejects stale or forged catalogs", () => {
  vi.useFakeTimers();
  const setup = options();
  vi.advanceTimersByTime(300001);
  expect(() => buildSubscriptionRequest(setup)).toThrow();
  expect(() =>
    buildSubscriptionRequest({
      ...options(),
      catalog: {
        models: [{ slug: "fixture-visible", displayName: "Forged" }],
        toJSON: () => ({ type: "forged" }),
      },
    }),
  ).toThrow();
});
it("rejects Pi sampling/hooks and forbidden overrides rather than forwarding them", () => {
  for (const key of [
    "temperature",
    "max_output_tokens",
    "previous_response_id",
    "background",
    "onPayload",
    "samplingParams",
    "metadata",
    "store",
    "stream",
  ])
    expect(() =>
      buildSubscriptionRequest({ ...options(), [key]: "synthetic-secret" }),
    ).toThrow("validation failed");
});
it("rejects system roles, tool payloads, duplicate model slugs and oversized history", () => {
  expect(() =>
    buildSubscriptionRequest({
      ...options(),
      input: [{ role: "system", content: "synthetic-secret" }],
    } as never),
  ).toThrow();
  expect(() =>
    buildSubscriptionRequest({
      ...options(),
      input: [{ role: "user", content: "question", tool_call: "unsupported" }],
    } as never),
  ).toThrow();
  expect(() =>
    parseCatalog({ models: [...body.models, body.models[0]] }, identity),
  ).toThrow();
  expect(() =>
    buildSubscriptionRequest({
      ...options(),
      input: Array.from({ length: 10 }, () => ({
        role: "user",
        content: "x".repeat(65536),
      })),
    }),
  ).toThrow();
});
it("validation errors never interpolate input values", () => {
  try {
    buildSubscriptionRequest({ ...options(), model: "synthetic-secret" });
  } catch (error) {
    expect(String(error)).not.toContain("synthetic-secret");
  }
});
