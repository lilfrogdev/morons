import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openNodeOptChat } from '@morons/optchat/node';
import { createMemoryRuntime, createPiMemoryCompressor } from '../src/memory-runtime.mjs';

const session = { id: 'chat-a', moronId: 'repo' };
const requestId = '11111111-1111-4111-8111-111111111111';
const modelRef = { provider: 'openai', modelId: 'gpt-test' };
const raw = 'The repository decision is to keep migration steps reversible. '.repeat(20);
const entries = [
  { id: 1, kind: 'pi.user', model: [{ content: 'Question?\n\n[OptChat memory injected]' }] },
  { id: 2, kind: 'pi.assistant', model: [{ content: [{ type: 'text', text: raw }] }] },
];
function fixture(memory, accountId = 'owner', compressor) {
  const catalog = {
    listReplies: () => [{ text: 'Question?\n\n[OptChat memory injected]', display_text: 'Question?' }],
    memoryDate: () => '2026-10-15T00:00:00Z',
  };
  const conversation = { entries: async (_query, _limit, _cursor, context) => {
    assert.equal(context, 'context');
    return { items: entries };
  } };
  return { runtime: createMemoryRuntime({ memory, catalog, accountId, piContext: 'context', compressor }), conversation };
}

test('Pi compressor sends frozen OptChat claim to selected entitled model', async () => {
  const calls = [];
  const model = { id: 'gpt-test', provider: 'openai' };
  const compressor = createPiMemoryCompressor({
    getModel: (provider, id) => provider === 'openai' && id === model.id ? model : null,
    getAvailable: async () => [model],
    completeSimple: async (selected, context, options) => {
      calls.push({ selected, context, options });
      return { stopReason: 'stop', content: [{ type: 'text', text: 'Keep migration steps reversible.' }] };
    },
  });
  assert.equal(await compressor({ job: { source: raw }, modelRef }), 'Keep migration steps reversible.');
  assert.equal(calls[0].selected, model);
  assert.equal(calls[0].context.messages[0].content, raw);
  assert.match(calls[0].context.systemPrompt, /untrusted text/);
  assert.equal(await compressor({ job: { source: raw }, modelRef: { provider: 'morons-fixture', modelId: 'fixture' } }), null);
  assert.equal(calls.length, 1);
  assert.equal(await compressor.available({ provider: 'morons-fixture', modelId: 'fixture' }), null);
});

test('captures user and assistant, compresses natively, and keeps replay view frozen after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'morons-memory-runtime-'));
  const path = join(dir, 'memory.sqlite');
  let opened;
  try {
    opened = openNodeOptChat(path);
    let compressed = 0;
    let { runtime, conversation } = fixture(opened.memory, 'owner', async ({ job }) => {
      compressed++;
      return job.merge ? 'Question: reversible migration.' : 'Keep migration steps reversible.';
    });
    const first = await runtime.prepareTurn(conversation, session, requestId, modelRef);
    assert.equal(compressed, 2);
    assert.match(first.text, /Keep migration steps reversible/);
    assert.match(first.text, /Question\?/);
    assert.doesNotMatch(first.text, /memory injected/);
    assert.equal(opened.database.prepare('SELECT count(*) AS n FROM repo_memory_sources').get().n, 2);
    assert.equal(JSON.parse(opened.database.prepare('SELECT body FROM repo_memory_sources WHERE source_id=?')
      .get('pi:chat-a:2').body).text, raw);
    opened.database.close();
    opened = openNodeOptChat(path);
    ({ runtime, conversation } = fixture(opened.memory, 'owner', async () => {
      throw new Error('claimed compression must not run again');
    }));
    const replay = await runtime.prepareTurn(conversation, session, requestId, modelRef);
    assert.deepEqual(replay, first);
    assert.equal(opened.database.prepare('SELECT count(*) AS n FROM repo_memory_sources').get().n, 2);
    const another = fixture(opened.memory, 'other-owner').runtime;
    assert.equal((await another.prepareTurn({ entries: async () => ({ items: [] }) }, session, 'other-turn')).text, '');
    assert.throws(() => opened.memory.assertTurnReferences(first.turnId, another.accessFor(session), another.authorize,
      first.sourceRefs), /memory_turn_conflict/);
  } finally {
    opened?.database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('failed compression does not invent a summary or overwrite raw source', async () => {
  const { memory, database } = openNodeOptChat(':memory:');
  try {
    const { runtime, conversation } = fixture(memory, 'owner', async () => { throw new Error('offline'); });
    await runtime.prepareTurn(conversation, session, requestId, modelRef);
    const row = database.prepare('SELECT body FROM repo_memory_sources WHERE source_id=?').get('pi:chat-a:2');
    assert.equal(JSON.parse(row.body).text, raw);
    assert.equal(database.prepare('SELECT ready FROM repo_memory_nodes WHERE level=0 AND position=1').get().ready, 0);
  } finally { database.close(); }
});
