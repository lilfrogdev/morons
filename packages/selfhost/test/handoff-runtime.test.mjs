import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHandoffExtension, openHandoffStore, userGrantsHandoff } from '../src/handoff-runtime.mjs';

function fixture(store, { grant = 'Please reach out to @freddy about the grocery budget.',
    allow = true, answer = 'The grocery budget is $200.' } = {}) {
  const source = { id: 'fitness-main', moronId: 'fitness', conversationId: 41 };
  const target = { id: 'freddy', rules: 'Finance only', preferences: '' };
  const calls = { ensure: [], ask: [] };
  const catalog = {
    getSessionByConversation: (id) => id === 41 ? source : undefined,
    getMoron: (id) => id === 'freddy' ? target : undefined,
  };
  const extension = createHandoffExtension({ store, catalog,
    getSourceUserEntryId: async () => '100',
    getUserGrant: async () => grant,
    authorizeTarget: async () => allow,
    ensureTargetSession: async (args) => { calls.ensure.push(args); },
    askTarget: async (args) => { calls.ask.push(args); return answer; },
  });
  const api = (callId = 'call-1', userEntryId = 100) => ({
    conversationId: 41, callId,
    conversation: async () => ({ entries: async () => ({ items: [
      { kind: 'pi.assistant', id: 101 }, { kind: 'pi.user', id: userEntryId },
    ] }) }),
  });
  return { tool: extension.tools[0], calls, api };
}

test('only a current user request grants a named target', () => {
  assert.equal(userGrantsHandoff('Could you reach out to @freddy?', 'freddy'), true);
  assert.equal(userGrantsHandoff('Please ask @freddy about lunch.', 'freddy'), true);
  assert.equal(userGrantsHandoff('Ask @freddy tomorrow', 'fitness'), false);
  assert.equal(userGrantsHandoff('I merely quoted @freddy', 'freddy'), false);
  assert.equal(userGrantsHandoff('reach out to @freddy-other', 'freddy'), false);
  assert.equal(userGrantsHandoff('Do not ask @freddy about this.', 'freddy'), false);
  assert.equal(userGrantsHandoff('I quoted "ask @freddy" in a document.', 'freddy'), false);
});

test('tool persists scoped provenance and replays without contacting target again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'morons-tool-handoff-'));
  const path = join(dir, 'handoff.sqlite');
  let store = openHandoffStore(path);
  try {
    let { tool, api, calls } = fixture(store);
    const args = { targetMoronId: 'freddy', question: 'What is the grocery budget?' };
    const first = await tool.execute(args, api());
    assert.match(first.output[0].text, /Scoped answer from @freddy: The grocery budget is \$200\./);
    assert.equal(calls.ensure.length, 1);
    assert.equal(calls.ask.length, 1);
    assert.equal(calls.ask[0].question, args.question);
    assert.match(calls.ask[0].requestId, /^[0-9a-f-]{36}$/);
    assert.match(calls.ask[0].targetSessionId, /^handoff-[0-9a-f]{24}$/);
    const saved = store.getTurn('fitness-main', '100');
    assert.equal(saved.target_moron_id, 'freddy');
    assert.equal(saved.source_moron_id, 'fitness');
    assert.equal(saved.answer, 'The grocery budget is $200.');
    store.close();
    store = openHandoffStore(path);
    ({ tool, api, calls } = fixture(store));
    const replay = await tool.execute(args, api());
    assert.deepEqual(replay.output, first.output);
    assert.equal(calls.ensure.length, 0);
    assert.equal(calls.ask.length, 0);
    assert.equal(store.list('fitness-main').length, 1);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('interrupted target request resumes with the same durable identifiers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'morons-tool-restart-'));
  const path = join(dir, 'handoff.sqlite');
  let store = openHandoffStore(path);
  const args = { targetMoronId: 'freddy', question: 'One narrow question' };
  try {
    let { tool, api, calls } = fixture(store, { answer: 'x'.repeat(4097) });
    await assert.rejects(tool.execute(args, api()), /handoff_answer_too_large/);
    const firstIds = calls.ask[0];
    assert.equal(store.getTurn('fitness-main', '100').answer, null);
    store.close();
    store = openHandoffStore(path);
    ({ tool, api, calls } = fixture(store, { answer: 'A bounded answer.' }));
    await tool.execute(args, api());
    assert.deepEqual(calls.ask[0], firstIds);
    assert.equal(store.getTurn('fitness-main', '100').answer, 'A bounded answer.');
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('denies ungiven, missing, self, policy-blocked and second target calls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'morons-tool-denial-'));
  const store = openHandoffStore(join(dir, 'handoff.sqlite'));
  try {
    const args = { targetMoronId: 'freddy', question: 'Budget?' };
    let { tool, api, calls } = fixture(store, { grant: 'Tell me a joke.' });
    await assert.rejects(tool.execute(args, api()), /handoff_not_user_granted/);
    assert.equal(calls.ask.length, 0);
    ({ tool, api, calls } = fixture(store, { allow: false }));
    await assert.rejects(tool.execute(args, api()), /handoff_target_forbidden/);
    assert.equal(calls.ask.length, 0);
    ({ tool, api, calls } = fixture(store));
    await assert.rejects(tool.execute({ targetMoronId: 'fitness', question: 'Budget?' }, api()), /invalid_handoff/);
    ({ tool, api } = fixture(store, { grant: 'Please reach out to @unknown.' }));
    await assert.rejects(tool.execute({ targetMoronId: 'unknown', question: 'Budget?' }, api()), /handoff_target_forbidden/);
    ({ tool, api, calls } = fixture(store));
    await tool.execute(args, api());
    await assert.rejects(tool.execute(args, api('call-2')), /handoff_turn_limit_or_conflict/);
    await assert.rejects(tool.execute({ ...args, question: 'Changed' }, api()), /handoff_turn_limit_or_conflict/);
    assert.equal(calls.ask.length, 1);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('parallel tool calls reserve only one target', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'morons-tool-parallel-'));
  const store = openHandoffStore(join(dir, 'handoff.sqlite'));
  try {
    const { tool, api, calls } = fixture(store);
    const args = { targetMoronId: 'freddy', question: 'Budget?' };
    const results = await Promise.allSettled([
      tool.execute(args, api('call-a')),
      tool.execute(args, api('call-b')),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.equal(calls.ask.length, 1);
    assert.equal(store.list('fitness-main').length, 1);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
