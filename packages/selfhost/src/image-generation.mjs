import { createHash } from 'node:crypto';
import { chmod, lstat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { Type } from 'typebox';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';

export const IMAGE_MODEL = 'gpt-image-2.5-sunburst';
const MAX_IMAGE = 16 * 1024 * 1024;
const MAX_RESPONSE = 24 * 1024 * 1024;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const safeId = (value) => typeof value === 'string' && /^[a-z][a-z0-9-]{1,79}$/.test(value);

export function imageProviderFromEnvironment(env = process.env, accountId = null) {
  const key = env.MORONS_IMAGE_OPENAI_API_KEY;
  if (!accountId || env.MORONS_IMAGE_ACCOUNT_ID !== accountId || typeof key !== 'string' ||
      !key.startsWith('sk-') || key.length < 20 || key.length > 512 || /\s/.test(key)) return null;
  return { apiKey: key, model: IMAGE_MODEL };
}

function pngDimensions(bytes) {
  if (bytes.length < 33 || bytes.length > MAX_IMAGE || !bytes.subarray(0, 8).equals(PNG) ||
      bytes.subarray(12, 16).toString('ascii') !== 'IHDR') throw new Error('invalid_image_result');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > 4096 || height > 4096 || width * height > 8388608)
    throw new Error('invalid_image_dimensions');
  return { width, height };
}

async function boundedJson(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > MAX_RESPONSE) throw new Error('image_response_too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function openImageGeneration({ filePath, accountId, catalog, provider = null,
  isHandoffTarget = () => false, fetchImpl = fetch, recordUsage = () => {}, authorizeGeneration = async () => ({}) }) {
  if (typeof accountId !== 'string' || !accountId || accountId.length > 128) throw new Error('image_account_required');
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()))
      throw new Error('private_image_database_required');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const db = new DatabaseSync(filePath);
  try {
    await chmod(filePath, 0o600);
    db.exec(`PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS images (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL, moron_id TEXT NOT NULL, call_id TEXT NOT NULL,
        title TEXT NOT NULL, prompt_hash TEXT NOT NULL, model TEXT NOT NULL,
        status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        width INTEGER, height INTEGER, bytes BLOB, usage_json TEXT, error TEXT);
      CREATE INDEX IF NOT EXISTS images_scope ON images(account_id, workspace_id, session_id, created_at);`);
    db.prepare("UPDATE images SET status='uncertain', error='Generation interrupted; provider completion and charges are unknown' WHERE status='generating' AND account_id=?").run(accountId);
    for (const row of db.prepare('SELECT id, session_id, created_at, usage_json FROM images WHERE account_id=?').all(accountId)) {
      if (!catalog.getSession(row.session_id)) continue;
      const saved = row.usage_json ? JSON.parse(row.usage_json) : null;
      await recordUsage({ id: row.id, sessionId: row.session_id, kind: 'image', provider: 'openai-images',
        modelId: IMAGE_MODEL, timestamp: row.created_at, usage: saved ? { input: saved.input_tokens,
          output: saved.output_tokens, cacheRead: 0, cacheWrite: 0, totalTokens: saved.total_tokens } : null });
    }
  } catch (error) { db.close(); throw error; }
  const active = new Map();
  const configured = Boolean(provider?.apiKey && provider.model === IMAGE_MODEL);
  let closed = false;
  function scope(sessionId) {
    const session = catalog.getSession(sessionId);
    const moron = session && catalog.getMoron(session.moronId);
    if (!session || !moron || moron.archived || !safeId(moron.workspaceId)) throw new Error('image_scope_forbidden');
    return { accountId, workspaceId: moron.workspaceId, sessionId, moronId: moron.id };
  }
  function rowInScope(sessionId, id) {
    const owner = scope(sessionId);
    return db.prepare('SELECT * FROM images WHERE id=? AND account_id=? AND workspace_id=? AND session_id=? AND moron_id=?')
      .get(id, accountId, owner.workspaceId, sessionId, owner.moronId);
  }
  function metadata(row) {
    return { id: row.id, accountId: row.account_id, workspaceId: row.workspace_id,
      sessionId: row.session_id, moronId: row.moron_id, title: row.title, status: row.status,
      model: row.model, createdAt: row.created_at, width: row.width, height: row.height,
      byteLength: row.byte_length ?? row.bytes?.length ?? 0, mimeType: 'image/png', error: row.error,
      usage: row.usage_json ? JSON.parse(row.usage_json) : null, costKnown: false };
  }
  function status() {
    return { configured, provider: 'openai-images', model: IMAGE_MODEL,
      authentication: 'separate_server_api_key', subscriptionSupported: false,
      message: configured ? 'Images use separately billed OpenAI API usage.' :
        'Image generation requires a separate server OpenAI API key. ChatGPT sign-in does not include images.' };
  }
  function list(sessionId) {
    const owner = scope(sessionId);
    return db.prepare(`SELECT id,account_id,workspace_id,session_id,moron_id,title,status,model,created_at,
      width,height,length(bytes) AS byte_length,usage_json,error FROM images
      WHERE account_id=? AND workspace_id=? AND session_id=? AND moron_id=?
      ORDER BY created_at DESC, id DESC LIMIT 20`).all(accountId, owner.workspaceId, sessionId, owner.moronId).map(metadata);
  }
  async function generate({ sessionId, callId, prompt, title, size = '1024x1024', quality = 'medium' }, signal) {
    if (closed) throw new Error('image_runtime_closed');
    const owner = scope(sessionId);
    const session = catalog.getSession(sessionId);
    if (catalog.repositoryForMoron(owner.moronId) || catalog.getMoron(owner.moronId).role === 'implementation' ||
        isHandoffTarget(session)) throw new Error('image_main_moron_required');
    if (typeof callId !== 'string' || !callId || callId.length > 256 || typeof prompt !== 'string' ||
        !prompt.trim() || prompt.length > 12000 || typeof title !== 'string' || !title.trim() || title.length > 120 ||
        !['1024x1024', '1536x1024', '1024x1536'].includes(size) || !['low', 'medium', 'high'].includes(quality))
      throw new Error('invalid_image_request');
    const id = `img-${createHash('sha256').update(JSON.stringify([accountId, sessionId, callId])).digest('hex').slice(0, 32)}`;
    const promptHash = createHash('sha256').update(JSON.stringify([prompt, title, size, quality])).digest('hex');
    const prior = rowInScope(sessionId, id);
    if (prior) {
      if (prior.prompt_hash !== promptHash) throw new Error('image_request_conflict');
      return metadata(prior);
    }
    if (!configured) throw new Error('image_api_key_required_subscription_unsupported');
    if (active.size >= 2 || [...active.values()].some((item) => item.sessionId === sessionId))
      throw new Error('image_generation_busy');
    signal?.throwIfAborted();
    const grant = await authorizeGeneration(Object.freeze({ ...owner, callId, imageId: id, prompt,
      title, model: IMAGE_MODEL, size, quality }), signal) ?? {};
    let admitted = false;
    try {
      if (closed) throw new Error('image_runtime_closed');
      const raced = rowInScope(sessionId, id);
      if (raced) {
        if (raced.prompt_hash !== promptHash) throw new Error('image_request_conflict');
        return metadata(raced);
      }
      if (active.size >= 2 || [...active.values()].some((item) => item.sessionId === sessionId))
        throw new Error('image_generation_busy');
      signal?.throwIfAborted();
      grant.signal?.throwIfAborted();
      const now = Date.now();
      db.prepare(`INSERT INTO images (id,account_id,workspace_id,session_id,moron_id,call_id,title,prompt_hash,
        model,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'generating',?,?)`)
        .run(id, accountId, owner.workspaceId, sessionId, owner.moronId, callId, title.trim(), promptHash, IMAGE_MODEL, now, now);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort('timeout'), 240000);
      const cancel = () => controller.abort('cancelled');
      signal?.addEventListener('abort', cancel, { once: true });
      grant.signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted || grant.signal?.aborted) cancel();
      active.set(id, { controller, sessionId });
      admitted = true;
      let usage = null, sent = false, statusCode = null;
      try {
        sent = true;
        const response = await fetchImpl('https://api.openai.com/v1/images/generations', {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: IMAGE_MODEL, prompt, n: 1, size, quality, output_format: 'png' }),
        });
        statusCode = response.status;
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(response.status === 401 || response.status === 403 ? 'image_provider_access_rejected' :
            response.status === 429 ? 'image_provider_rate_limited' : 'image_provider_failed');
        }
        const result = await boundedJson(response);
        const counts = ['input_tokens', 'output_tokens', 'total_tokens'];
        usage = result.usage && counts.every((name) => Number.isSafeInteger(result.usage[name]) && result.usage[name] >= 0)
          ? Object.fromEntries(counts.map((name) => [name, result.usage[name]])) : null;
        controller.signal.throwIfAborted();
        const encoded = result.data?.length === 1 && result.data[0]?.b64_json;
        if (typeof encoded !== 'string' || encoded.length > Math.ceil(MAX_IMAGE / 3) * 4 ||
            !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('invalid_image_result');
        const bytes = Buffer.from(encoded, 'base64');
        const dimensions = pngDimensions(bytes);
        await grant.reassert?.();
        controller.signal.throwIfAborted();
        const currentScope = scope(sessionId);
        if (JSON.stringify(currentScope) !== JSON.stringify(owner)) throw new Error('image_scope_forbidden');
        db.prepare(`UPDATE images SET status='completed', updated_at=?, width=?, height=?, bytes=?, usage_json=? WHERE id=?`)
          .run(Date.now(), dimensions.width, dimensions.height, bytes, JSON.stringify(usage), id);
      } catch (error) {
        const uncertain = sent && (controller.signal.aborted || statusCode === null || statusCode >= 500 || statusCode >= 200 && statusCode < 300);
        const message = controller.signal.aborted ? 'Cancelled locally; provider completion and charges may still occur' :
          ['image_provider_access_rejected', 'image_provider_rate_limited', 'image_provider_failed', 'invalid_image_result',
            'invalid_image_dimensions', 'image_response_too_large'].includes(error.message) ? error.message : 'image_generation_failed';
        db.prepare('UPDATE images SET status=?, updated_at=?, usage_json=?, error=? WHERE id=?')
          .run(uncertain ? 'uncertain' : 'failed', Date.now(), JSON.stringify(usage), message, id);
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', cancel);
        grant.signal?.removeEventListener('abort', cancel);
        const converted = usage && Number.isSafeInteger(usage.input_tokens) && Number.isSafeInteger(usage.output_tokens)
          ? { input: usage.input_tokens, output: usage.output_tokens, cacheRead: 0, cacheWrite: 0,
            totalTokens: usage.total_tokens ?? usage.input_tokens + usage.output_tokens } : null;
        await recordUsage({ id, sessionId, kind: 'image', provider: 'openai-images', modelId: IMAGE_MODEL,
          timestamp: now, usage: converted });
      }
      return metadata(rowInScope(sessionId, id));
    } finally {
      try { await grant.finish?.(); }
      finally { if (admitted) active.delete(id); }
    }
  }
  const extension = defineExtension({ name: 'image-generation', tools: [defineTool({
    name: 'generate_image', replay: 'unsafe',
    description: 'Generate one real PNG image from a prompt when the user asks for an image. Requires a separately configured OpenAI API key and separately billed API usage. Return the saved image reference; never claim an image exists if generation did not complete.',
    parameters: Type.Object({ prompt: Type.String({ minLength: 1, maxLength: 12000 }),
      title: Type.String({ minLength: 1, maxLength: 120 }),
      size: Type.Optional(Type.Union(['1024x1024', '1536x1024', '1024x1536'].map((value) => Type.Literal(value)))),
      quality: Type.Optional(Type.Union(['low', 'medium', 'high'].map((value) => Type.Literal(value)))) }),
    async execute(args, api, context) {
      const session = catalog.getSessionByConversation(api.conversationId);
      if (!session) throw new Error('image_scope_forbidden');
      const image = await generate({ ...args, sessionId: session.id, callId: api.callId }, context?.abortSignal);
      return { output: [{ type: 'text', text: JSON.stringify({ imageId: image.id, status: image.status,
        title: image.title, error: image.error, instruction: image.status === 'completed' ?
          'The saved PNG is displayed in the chat image card. Refer to this card for Open and Save.' :
          'No image is available. Explain the failure or uncertain outcome without claiming success.' }) }] };
    },
  })] });
  return { status, list, generate, extension,
    read(sessionId, id) {
      const row = rowInScope(sessionId, id);
      if (!row || row.status !== 'completed' || !row.bytes) return null;
      return { bytes: Buffer.from(row.bytes), mimeType: 'image/png' };
    },
    cancel(sessionId, id) {
      if (!rowInScope(sessionId, id)) return false;
      const item = active.get(id);
      if (!item || item.sessionId !== sessionId) return false;
      item.controller.abort('cancelled');
      return true;
    },
    async close() {
      closed = true;
      for (const item of active.values()) item.controller.abort('shutdown');
      while (active.size) await new Promise((resolve) => setTimeout(resolve, 10));
      db.close();
    },
  };
}
