import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openAccountServer } from '../src/account-server.mjs';

const bootstrapToken = 'offline-test-bootstrap-token-32-characters-minimum';

test('two accounts isolate named Pi state while two device sessions share one account across restart', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'morons-account-'));
  let server;
  try {
    server = await openAccountServer({ dataDir, bootstrapToken });
    const call = async (method, path, data, token, extra = {}) => {
      const response = await fetch(`${server.url}${path}`, { method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
        body: data && JSON.stringify(data) });
      return { status: response.status, ...(await response.json()) };
    };
    assert.equal((await call('GET', '/v1/morons')).status, 401);
    assert.equal((await call('POST', '/v1/accounts/bootstrap', { name: 'alice', password: 'alice-test-password-123' }, null,
      { 'X-Morons-Bootstrap': bootstrapToken })).status, 201);
    assert.equal((await call('POST', '/v1/accounts/bootstrap', { name: 'evil', password: 'evil-test-password-123' }, null,
      { 'X-Morons-Bootstrap': bootstrapToken })).status, 403);
    assert.equal((await call('POST', '/v1/session/login', { name: 'alice', password: 'wrong-password-123' })).status, 401);
    const aliceMac = await call('POST', '/v1/session/login', { name: 'alice', password: 'alice-test-password-123' });
    const alicePc = await call('POST', '/v1/session/login', { name: 'alice', password: 'alice-test-password-123' });
    assert.equal(aliceMac.status, 200);
    assert.notEqual(aliceMac.token, alicePc.token);
    assert.equal((await call('POST', '/v1/accounts', { name: 'bob', password: 'bob-test-password-123' }, aliceMac.token)).status, 201);
    const bob = await call('POST', '/v1/session/login', { name: 'bob', password: 'bob-test-password-123' });
    assert.equal((await call('POST', '/v1/accounts', { name: 'charlie', password: 'charlie-test-password-123' }, bob.token)).status, 403);
    await call('POST', '/v1/morons', { id: 'repo', name: 'Alice Repo', rules: '', preferences: '' }, aliceMac.token);
    await call('POST', '/v1/morons/repo/sessions', { id: 'repo-main' }, aliceMac.token);
    const message = await call('POST', '/v1/sessions/repo-main/chat', {
      requestId: '11111111-1111-4111-8111-111111111111', text: 'Alice private decision',
    }, aliceMac.token);
    assert.equal(message.status, 200);
    assert.equal((await call('GET', '/v1/sessions/repo-main/history', null, alicePc.token)).messages[0].text, 'Alice private decision');
    assert.equal((await call('GET', '/v1/sessions/repo-main/history', null, bob.token)).status, 404);
    await call('POST', '/v1/morons', { id: 'repo', name: 'Bob Repo', rules: '', preferences: '' }, bob.token);
    await call('POST', '/v1/morons/repo/sessions', { id: 'repo-main' }, bob.token);
    assert.equal((await call('GET', '/v1/sessions/repo-main/history', null, bob.token)).messages.length, 0);
    await server.close();
    server = await openAccountServer({ dataDir, bootstrapToken });
    assert.equal((await call('GET', '/v1/sessions/repo-main/history', null, alicePc.token)).messages[0].text, 'Alice private decision');
    assert.equal((await call('GET', '/v1/sessions/repo-main/history', null, bob.token)).messages.length, 0);
    await call('POST', '/v1/session/logout', {}, aliceMac.token);
    assert.equal((await call('GET', '/v1/morons', null, aliceMac.token)).status, 401);
    assert.equal((await call('GET', '/v1/morons', null, alicePc.token)).status, 200);
  } finally {
    await server?.close().catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('bootstrap admits one administrator under concurrent requests and rate limit is address-wide', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'morons-bootstrap-'));
  let server;
  try {
    server = await openAccountServer({ dataDir, bootstrapToken });
    const bootstrap = (name) => fetch(`${server.url}/v1/accounts/bootstrap`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Morons-Bootstrap': bootstrapToken },
      body: JSON.stringify({ name, password: 'offline-password-12345' }) });
    const responses = await Promise.all([bootstrap('first'), bootstrap('second')]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [201, 403]);
    const attempts = [];
    for (let i = 0; i < 22; i++) attempts.push(await fetch(`${server.url}/v1/session/login`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `random-${i}`, password: 'wrong-password-123' }) }));
    assert.equal(attempts.at(-1).status, 429);
  } finally {
    await server?.close().catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('dead-owner lock is recovered while a live-owner lock is refused', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'morons-lock-'));
  let server;
  try {
    await writeFile(join(dataDir, '.owner.lock'), JSON.stringify({ pid: 999999999, nonce: 'dead' }));
    server = await openAccountServer({ dataDir, bootstrapToken });
    await assert.rejects(openAccountServer({ dataDir, bootstrapToken }), /account_server_already_owned/);
  } finally {
    await server?.close().catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  }
});
