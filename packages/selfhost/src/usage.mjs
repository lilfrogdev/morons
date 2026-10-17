import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { baseModelId } from './fast-models.mjs';

const windows = new Map([['all', null], ['24h', 86400000], ['7d', 604800000],
  ['30d', 2592000000], ['90d', 7776000000]]);

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function empty() {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    cacheWriteTokens: 0, totalTokens: 0, estimatedCostUsd: 0,
    unknownCostCalls: 0, unknownUsageCalls: 0 };
}

function completeUsage(usage) {
  return usage && ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']
    .every((key) => typeof usage[key] === 'number' && Number.isFinite(usage[key]) && usage[key] >= 0);
}

function increment(target, usage, estimatedCost) {
  target.calls++;
  if (!completeUsage(usage)) target.unknownUsageCalls++;
  target.inputTokens += number(usage?.input);
  target.outputTokens += number(usage?.output);
  target.cacheReadTokens += number(usage?.cacheRead);
  target.cacheWriteTokens += number(usage?.cacheWrite);
  target.totalTokens += number(usage?.totalTokens) ||
    number(usage?.input) + number(usage?.output) + number(usage?.cacheRead) + number(usage?.cacheWrite);
  if (estimatedCost !== null) target.estimatedCostUsd += estimatedCost;
  else target.unknownCostCalls++;
}

function estimatedCost(models, provider, modelId, usage) {
  if (!completeUsage(usage)) return null;
  if (provider === 'morons-fixture') return 0;
  if (number(usage?.cost?.total) > 0) return usage.cost.total;
  const rates = models.getModel(provider, baseModelId(modelId))?.cost;
  if (!rates || !['input', 'output', 'cacheRead', 'cacheWrite']
    .some((key) => number(rates[key]) > 0)) return null;
  const inputTokens = number(usage.input) + number(usage.cacheRead) + number(usage.cacheWrite);
  const tier = (rates.tiers ?? []).filter((candidate) => inputTokens > candidate.inputTokensAbove)
    .sort((a, b) => b.inputTokensAbove - a.inputTokensAbove)[0] ?? rates;
  const longWrite = number(usage.cacheWrite1h);
  return (number(tier.input) * number(usage.input) + number(tier.output) * number(usage.output) +
    number(tier.cacheRead) * number(usage.cacheRead) +
    number(tier.cacheWrite) * Math.max(0, number(usage.cacheWrite) - longWrite) +
    number(tier.input) * 2 * longWrite) / 1_000_000;
}

function period(timestamp, hourly) {
  const date = new Date(timestamp);
  if (hourly) date.setUTCMinutes(0, 0, 0);
  else date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}

export function usageFilters(searchParams) {
  const workspaceId = searchParams.get('workspaceId') ?? 'personal';
  const window = searchParams.get('window') ?? 'all';
  const provider = searchParams.get('provider') ?? null;
  const model = searchParams.get('model') ?? null;
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(workspaceId) || !windows.has(window) ||
      (provider !== null && (provider.length > 80 || !/^[a-z0-9][a-z0-9-]*$/.test(provider))) ||
      (model !== null && (model.length > 128 || !/^[a-zA-Z0-9][a-zA-Z0-9._~:-]*$/.test(model))))
    throw new Error('invalid_usage_filter');
  return { workspaceId, window, provider, model };
}

export async function collectUsage({ catalog, harness, models, filters, now = Date.now() }) {
  const morons = catalog.listMorons(filters.workspaceId);
  const sessions = morons.flatMap((moron) => catalog.listSessions(moron.id)
    .map((session) => ({ ...session, kind: catalog.implementationForChild(session.id) ? 'implementation' :
      session.id.startsWith('handoff-') || catalog.isHandoffTarget(session.id) ? 'handoff' : 'main' })));
  const sessionIds = sessions.map((session) => session.id);
  const cutoff = windows.get(filters.window) === null ? -Infinity : now - windows.get(filters.window);
  const totals = empty();
  const providers = new Map();
  const modelTotals = new Map();
  const observedProviders = new Set();
  const observedModels = new Set();
  const periods = new Map();
  const kinds = { main: 0, handoff: 0, memory: 0, implementation: 0, image: 0 };
  const hourly = filters.window === '24h';
  const include = ({ provider, modelId, timestamp, usage, kind }) => {
    if (!Number.isFinite(timestamp) || timestamp < cutoff || timestamp > now) return;
    provider = typeof provider === 'string' && provider ? provider : 'unknown';
    modelId = typeof modelId === 'string' && modelId ? modelId : 'unknown';
    const canonical = baseModelId(modelId);
    observedProviders.add(provider);
    observedModels.add(`${provider}\0${canonical}`);
    if (filters.provider && filters.provider !== provider ||
        filters.model && filters.model !== canonical) return;
    const cost = estimatedCost(models, provider, modelId, usage);
    increment(totals, usage, cost);
    if (!providers.has(provider)) providers.set(provider, empty());
    increment(providers.get(provider), usage, cost);
    const key = `${provider}\0${canonical}`;
    if (!modelTotals.has(key)) modelTotals.set(key, empty());
    increment(modelTotals.get(key), usage, cost);
    const start = period(timestamp, hourly);
    if (!periods.has(start)) periods.set(start, empty());
    increment(periods.get(start), usage, cost);
    if (Object.hasOwn(kinds, kind)) kinds[kind]++;
  };
  for (const session of sessions) {
    const conversation = await harness.conversation(session.conversationId, BACKGROUND_CONTEXT);
    let minEntryId = 0;
    while (true) {
      const page = await conversation.entries({ order: 'ascending',
        ...(minEntryId ? { minEntryId } : {}) }, 200, undefined, BACKGROUND_CONTEXT);
      for (const entry of page.items) {
        if (entry.kind !== 'pi.assistant') continue;
        for (const message of entry.model ?? []) {
          if (message.role !== 'assistant') continue;
          include({ provider: message.provider, modelId: message.model,
            timestamp: message.timestamp, usage: message.usage, kind: session.kind });
        }
      }
      if (!page.next) break;
      const last = page.items.at(-1)?.id;
      if (!Number.isSafeInteger(last) || last < minEntryId) throw new Error('invalid_usage_page');
      minEntryId = last + 1;
    }
  }
  for (const item of catalog.listExternalUsage(sessionIds))
    include({ provider: item.provider, modelId: item.modelId,
      timestamp: item.timestamp, usage: item.usage, kind: item.kind });
  return {
    scope: { workspaceId: filters.workspaceId },
    filters: { window: filters.window, provider: filters.provider, model: filters.model },
    options: { providers: [...observedProviders].sort(),
      models: [...observedModels].sort().map((key) => ({ provider: key.split('\0')[0],
        model: key.split('\0')[1] })) },
    totals,
    providers: [...providers].map(([provider, value]) => ({ provider, ...value }))
      .sort((a, b) => b.totalTokens - a.totalTokens || a.provider.localeCompare(b.provider)),
    models: [...modelTotals].map(([key, value]) => ({ provider: key.split('\0')[0],
      model: key.split('\0')[1], ...value }))
      .sort((a, b) => b.totalTokens - a.totalTokens || a.provider.localeCompare(b.provider)),
    periods: [...periods].map(([start, value]) => ({ start, ...value }))
      .sort((a, b) => a.start.localeCompare(b.start)),
    coverage: { kinds, actualTokens: false, actualSpend: false,
      subagents: 'included_by_kind',
      note: 'Persisted assistant, delegated implementation, Moron handoff, memory, and image calls are included. Compaction summaries and provider attempts without assistant entries are not yet attributed to time filters, so totals are partial. Cost is an estimate from model prices, not a bill; subscription charges and calls without reliable prices have unknown cost.' },
  };
}
