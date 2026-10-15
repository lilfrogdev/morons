import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openNodeOptChat } from '@morons/optchat/node';
import { createMemoryRuntime, createPiMemoryCompressor } from '../src/memory-runtime.mjs';
import { openCatalog } from '../src/catalog.mjs';

const session = { id: 'chat-a', moronId: 'repo' };
const requestId = '11111111-1111-4111-8111-111111111111';
const modelRef = { provider: 'openai', modelId: 'gpt-test' };
const raw = 'The repository decision is to keep migration steps reversible. '.repeat(20);
const entries = [
  { id: 1, kind: 'pi.user', model: [{ content: 'Question?\n\n[OptChat memory injected]' }] },
  { id: 2, kind: 'pi.assistant', model: [{ content: [{ type: 'text', text: raw }] }] },
];
function fixture(memory, accountId = 'owner', compressor) {
  let memoryCursor = 0;
  let memorySourceCount = 0;
  const catalog = {
    displayTextForSubmitted: (_sessionId, text) => text === 'Question?\n\n[OptChat memory injected]' ? 'Question?' : undefined,
    memoryDate: () => '2026-10-15T00:00:00Z',
    memoryCursor: () => memoryCursor,
    memorySourceCount: () => memorySourceCount,
    advanceMemoryCursor: (_sessionId, entryId, sourceCount) => {
      memoryCursor = entryId; memorySourceCount = sourceCount;
    },
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

test('incremental sync crosses 6,400 entries, resumes after a partial page, and reads no old pages after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'morons-memory-cursor-'));
  const catalogPath = join(dir, 'catalog.sqlite');
  const memoryPath = join(dir, 'memory.sqlite');
  let catalog;
  let opened;
  try {
    catalog = openCatalog(catalogPath);
    catalog.createMoron({ id: 'repo', name: 'Repo', rules: '', preferences: '' });
    catalog.createSession(session.id, 'repo', '1');
    opened = openNodeOptChat(memoryPath);
    let total = 6_405;
    const queries = [];
    const conversation = { entries: async (query, limit) => {
      assert.equal(limit, 200);
      const start = query.minEntryId ?? 1;
      queries.push(start);
      const end = Math.min(total, start + limit - 1);
      const items = Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => ({
        id: start + index, kind: 'pi.user', model: [{ content: `entry-${start + index}` }],
      }));
      return { items, ...(end < total ? { next: { after: end } } : {}) };
    } };
    let seen = 0;
    const interrupted = { append(source) {
      if (++seen === 4_102) throw new Error('simulated_crash');
      return opened.memory.append(source);
    }, sourceInventory: (...args) => opened.memory.sourceInventory(...args) };
    const runtime = createMemoryRuntime({ memory: interrupted, catalog, accountId: 'owner', piContext: 'context' });
    await assert.rejects(runtime.sync(conversation, session), /simulated_crash/);
    assert.equal(catalog.memoryCursor(session.id), 4_000);
    assert.equal(catalog.memorySourceCount(session.id), 4_000);
    opened.database.close();
    catalog.close();
    opened = openNodeOptChat(memoryPath);
    catalog = openCatalog(catalogPath);
    const resumed = createMemoryRuntime({ memory: opened.memory, catalog, accountId: 'owner', piContext: 'context' });
    queries.length = 0;
    await resumed.sync(conversation, session);
    assert.equal(queries[0], 4_001);
    assert.equal(catalog.memoryCursor(session.id), 6_405);
    assert.equal(catalog.memorySourceCount(session.id), 6_405);
    assert.equal(opened.database.prepare('SELECT count(*) AS n FROM repo_memory_sources').get().n, 6_405);
    assert.equal(opened.database.prepare('SELECT count(DISTINCT scope) AS n FROM repo_memory_sources').get().n, 2);
    queries.length = 0;
    total = 6_407;
    await resumed.sync(conversation, session);
    assert.deepEqual(queries, [6_406]);
    assert.equal(catalog.memoryCursor(session.id), 6_407);
    assert.equal(catalog.memorySourceCount(session.id), 6_407);
    assert.equal(opened.database.prepare('SELECT count(*) AS n FROM repo_memory_sources').get().n, 6_407);
    const prepared = await resumed.prepareTurn(conversation, session, requestId,
      { provider: 'morons-fixture', modelId: 'fixture' });
    assert.ok(Buffer.byteLength(prepared.text) <= 2_200);
    opened.memory.assertTurnReferences(prepared.turnId, resumed.accessFor(session), resumed.authorize,
      prepared.sourceRefs);
    total = 6_409;
    await resumed.sync(conversation, session);
    const replay = await resumed.prepareTurn(conversation, session, requestId,
      { provider: 'morons-fixture', modelId: 'fixture' });
    assert.deepEqual(replay, prepared);
  } finally {
    opened?.database.close();
    catalog?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('legacy assistant sources stay in their original shard during user backfill', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'morons-memory-legacy-'));
  const catalog = openCatalog(join(dir, 'catalog.sqlite'));
  const opened = openNodeOptChat(join(dir, 'memory.sqlite'));
  try {
    catalog.createMoron({ id: 'repo', name: 'Repo', rules: '', preferences: '' });
    catalog.createSession(session.id, 'repo', '1');
    for (let id = 3; id <= 4_097; id++) opened.memory.append({
      sourceId: `pi:${session.id}:${id}`, projectId: 'owner', repository: 'repo',
      threadId: session.id, kind: 'assistant', date: '2026-10-15T00:00:00Z', text: `old-${id}`,
    });
    const conversation = { entries: async (query, limit) => {
      const start = query.minEntryId ?? 1;
      const end = Math.min(4_097, start + limit - 1);
      return { items: Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => {
        const id = start + index;
        return { id, kind: id < 3 ? 'pi.user' : 'pi.assistant',
          model: [{ content: id < 3 ? `new-${id}` : `old-${id}` }] };
      }), ...(end < 4_097 ? { next: { after: end } } : {}) };
    } };
    const runtime = createMemoryRuntime({ memory: opened.memory, catalog, accountId: 'owner', piContext: 'context' });
    await runtime.sync(conversation, session);
    assert.equal(catalog.memorySourceCount(session.id), 4_097);
    assert.equal(opened.database.prepare('SELECT count(*) AS n FROM repo_memory_sources').get().n, 4_097);
    assert.equal(opened.database.prepare('SELECT count(DISTINCT scope) AS n FROM repo_memory_sources').get().n, 2);
    assert.equal(opened.database.prepare("SELECT count(*) AS n FROM repo_memory_sources WHERE source_id='pi:chat-a:3'").get().n, 1);
  } finally {
    opened.database.close(); catalog.close(); await rm(dir, { recursive: true, force: true });
  }
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
