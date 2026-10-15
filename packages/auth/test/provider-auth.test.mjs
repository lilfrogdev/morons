import { test } from "node:test";
import assert from "node:assert/strict";
import { createProviderAuth } from "../src/provider-auth.mjs";
import { createPiProviderAuth } from "../src/pi-models.mjs";

test("login delegates to supported Pi API without returning secrets or account identity", async () => {
  const calls = [];
  const models = {
    async login(...args) { calls.push(args); return { type: "oauth", access: "secret" }; },
    async logout(provider) { calls.push(["logout", provider]); },
  };
  const credentials = { async list() { return [{ providerId: "openai", type: "oauth", access: "secret" }]; } };
  const auth = createProviderAuth({ models, credentials, getDeviceId: () => "stable-device" });
  const interaction = { prompt: async () => "mock", notify: () => {} };
  assert.deepEqual(await auth.loginOpenAI(interaction), { provider: "openai", connected: true });
  assert.equal(calls[0][0], "openai");
  assert.equal(calls[0][1], "oauth");
  assert.equal(calls[0][3].getDeviceId(), "stable-device");
  assert.equal(calls[0][3].agentName, "Morons");
  assert.deepEqual(await auth.status(), { providers: [{ provider: "openai", method: "oauth" }] });
  assert.deepEqual(await auth.logoutOpenAI(), { provider: "openai", connected: false, remoteRevocation: "not_confirmed" });
  assert.deepEqual(calls[1], ["logout", "openai"]);
});

test("login requires human interaction and serializes concurrent requests", async () => {
  let resolveLogin;
  const models = { login: () => new Promise((resolve) => { resolveLogin = resolve; }) };
  const auth = createProviderAuth({ models, credentials: { list: async () => [] }, getDeviceId: () => "stable-device" });
  await assert.rejects(auth.loginOpenAI({}), /interactive_login_required/);
  const first = auth.loginOpenAI({ prompt: async () => "", notify() {} });
  await assert.rejects(auth.loginOpenAI({ prompt: async () => "", notify() {} }), /login_in_progress/);
  resolveLogin({ type: "oauth" });
  await first;
});

test("Pi 1.2 OpenAI provider is registered with the app-owned credential store", () => {
  const credentials = { read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => {} };
  const { models, auth } = createPiProviderAuth({ credentials, getDeviceId: () => "test-device" });
  assert.equal(models.getProvider("openai").id, "openai");
  assert.equal(typeof models.getProvider("openai").auth.oauth.login, "function");
  assert.equal(typeof auth.loginOpenAI, "function");
});
