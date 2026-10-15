import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openAccountServer } from '../src/account-server.mjs';
import { createModels } from '@earendil-works/pi-ai/models';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { openProviderRuntime } from '../src/provider-runtime.mjs';
import { createProviderFlow } from '../src/provider-flow.mjs';

test('provider status reconciles persisted credential metadata after restart', async () => {
  const auth = { status: async () => ({ providers: [{ provider: 'openai', method: 'oauth' }] }) };
  const restarted = createProviderFlow(auth);
  assert.deepEqual(await restarted.status(), { state: 'connected' });
  auth.status = async () => ({ providers: [] });
  assert.deepEqual(await restarted.status(), { state: 'disconnected' });
});

test('account-scoped OAuth handoff uses Pi-style callbacks and never returns credentials', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'morons-provider-'));
  const bootstrapToken = 'mock-provider-bootstrap-token-123456789';
  let server;
  try {
    let received;
    server = await openAccountServer({ dataDir, bootstrapToken, providerFactory: async () => ({
      async loginOpenAI(interaction) {
        interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/api/accounts/authorize?state=mock' });
        received = await interaction.prompt({ type: 'manual_code', message: 'Callback URL' });
        return { access: 'must-not-leak', refresh: 'must-not-leak' };
      },
      async logoutOpenAI() {},
    }) });
    const call = async (method, path, body, token) => {
      const response = await fetch(`${server.url}${path}`, { method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(path === '/v1/accounts/bootstrap' ? { 'X-Morons-Bootstrap': bootstrapToken } : {}) },
        body: body && JSON.stringify(body) });
      return { status: response.status, ...(await response.json()) };
    };
    await call('POST', '/v1/accounts/bootstrap', { name: 'owner', password: 'offline-password-123' });
    const { token } = await call('POST', '/v1/session/login', { name: 'owner', password: 'offline-password-123' });
    assert.equal((await call('GET', '/v1/provider/openai/status')).status, 401);
    assert.equal((await call('POST', '/v1/provider/openai/start', {}, token)).status, 202);
    const state = (await call('GET', '/v1/provider/openai/status', null, token)).provider;
    assert.equal(state.state, 'awaiting_callback');
    assert.match(state.authorizationUrl, /^https:\/\/auth\.openai\.com\//);
    const callback = 'http://127.0.0.1:1455/auth/callback?code=mock&state=mock';
    assert.equal((await call('POST', '/v1/provider/openai/callback', { url: callback }, token)).status, 200);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(received, callback);
    const connected = await call('GET', '/v1/provider/openai/status', null, token);
    assert.equal(connected.provider.state, 'connected');
    assert.ok(!JSON.stringify(connected).includes('must-not-leak'));
    assert.equal((await call('POST', '/v1/provider/openai/logout', {}, token)).provider.state, 'disconnected');
  } finally { await server?.close().catch(() => {}); await rm(dataDir, { recursive: true, force: true }); }
});

test('OAuth is explicitly unavailable without an owner-private provider store', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'morons-provider-disabled-'));
  const bootstrapToken = 'mock-provider-bootstrap-token-123456789';
  let server;
  try {
    server = await openAccountServer({ dataDir, bootstrapToken });
    const call = (path, token) => fetch(`${server.url}${path}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(path === '/v1/accounts/bootstrap' ? { 'X-Morons-Bootstrap': bootstrapToken } : {}) },
      body: path === '/v1/accounts/bootstrap' ? JSON.stringify({ name: 'owner', password: 'offline-password-123' }) :
        path === '/v1/session/login' ? JSON.stringify({ name: 'owner', password: 'offline-password-123' }) : '{}' });
    await call('/v1/accounts/bootstrap');
    const token = (await (await call('/v1/session/login')).json()).token;
    const response = await call('/v1/provider/openai/start', token);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'provider_store_unavailable' });
  } finally { await server?.close().catch(() => {}); await rm(dataDir, { recursive: true, force: true }); }
});

test('configured Pi provider model handles chat while repository tools stay unavailable', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'morons-provider-model-'));
  const bootstrapToken = 'mock-provider-bootstrap-token-123456789';
  let server;
  try {
    const models = createModels();
    const model = { id: 'gpt-5-mini', name: 'Mock provider', provider: 'openai', api: 'openai-responses',
      baseUrl: 'https://invalid.example', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 4096 };
    const stream = () => {
      const events = createAssistantMessageEventStream();
      const answer = { role: 'assistant', content: [{ type: 'text', text: 'mock-provider-answer' }],
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { events.push({ type: 'start', partial: { ...answer, content: [] } });
        events.push({ type: 'done', reason: 'stop', message: answer }); });
      return events;
    };
    models.setProvider({ id: 'openai', name: 'Mock OpenAI',
      auth: { apiKey: { name: 'Mock', resolve: async () => ({ auth: { apiKey: 'never-sent' } }) } },
      getModels: () => [model], stream, streamSimple: stream });
    server = await openAccountServer({ dataDir, bootstrapToken,
      repositoryPlan: { repository: '/missing', allowedPaths: ['README.md'] },
      providerModelId: 'gpt-5-mini',
      providerFactory: async () => ({ models, auth: { loginOpenAI: async () => {}, logoutOpenAI: async () => {} } }) });
    const call = async (method, path, data, token, extra = {}) => {
      const response = await fetch(`${server.url}${path}`, { method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
        body: data && JSON.stringify(data) });
      return { status: response.status, ...(await response.json()) };
    };
    await call('POST', '/v1/accounts/bootstrap', { name: 'owner', password: 'offline-password-123' }, null,
      { 'X-Morons-Bootstrap': bootstrapToken });
    const token = (await call('POST', '/v1/session/login', { name: 'owner', password: 'offline-password-123' })).token;
    await call('POST', '/v1/morons', { id: 'repo', name: 'Repository', rules: '', preferences: '' }, token);
    await call('POST', '/v1/morons/repo/sessions', { id: 'repo' }, token);
    const chat = await call('POST', '/v1/sessions/repo/chat', {
      requestId: '99999999-9999-4999-8999-999999999999', text: 'hello',
    }, token);
    assert.equal(chat.status, 200, JSON.stringify(chat));
    assert.equal(chat.answer, 'mock-provider-answer');
    assert.equal((await call('GET', '/v1/sessions/repo/reviews', null, token)).reviews.length, 0);
  } finally { await server?.close().catch(() => {}); await rm(dataDir, { recursive: true, force: true }); }
});

test('real Pi ChatGPT adapter uses an encrypted account store and stable device ID without login', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'morons-provider-store-'));
  const masterKey = Buffer.alloc(32, 7);
  try {
    const first = await openProviderRuntime({ directory, accountId: 'account-1', masterKey });
    assert.equal(first.models.getProvider('openai').auth.oauth.loginLabel, 'Sign in with ChatGPT');
    assert.deepEqual(await first.auth.status(), { providers: [] });
    await first.close();
    const second = await openProviderRuntime({ directory, accountId: 'account-1', masterKey });
    assert.deepEqual(await second.auth.status(), { providers: [] });
    await second.close();
  } finally { masterKey.fill(0); await rm(directory, { recursive: true, force: true }); }
});
