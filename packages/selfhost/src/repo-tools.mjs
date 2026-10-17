import { createHash } from 'node:crypto';
import { Type } from 'typebox';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import { runReviewOperation } from './review.mjs';

function reviewId(conversationId, callId) {
  return createHash('sha256').update(`${conversationId}:${callId}`).digest('hex').slice(0, 16);
}

export function repoTools(catalog, planForSession, { admitOperation } = {}) {
  if (!planForSession) return null;
  const authorizedPlan = async (conversationId, baseRevision = null) => {
    const session = catalog.getSessionByConversation(conversationId);
    const repository = session && catalog.repositoryForMoron(session.moronId);
    const moron = session && catalog.getMoron(session.moronId);
    if (!repository || !moron || repository.workspaceId !== moron.workspaceId)
      throw new Error('repo_tool_forbidden');
    const plan = await planForSession(session, baseRevision);
    if (!plan) throw new Error('repo_tool_forbidden');
    return { session, plan };
  };
  const source = defineTool({
    name: 'source_read', replay: 'safe',
    description: 'Read one approved committed source file in the repository.',
    parameters: Type.Object({ path: Type.String({ maxLength: 512 }) }),
    async execute({ path }, api, callContext) {
      const { session, plan } = await authorizedPlan(api.conversationId);
      const grant = await admitOperation?.({ source: session, operation: 'read', path, signal: callContext.abortSignal });
      if (grant === false) throw new Error('repo_tool_permission_denied');
      try {
        await grant?.reassert?.();
        const signals = [callContext.abortSignal, grant?.signal].filter(Boolean);
        const signal = signals.length ? AbortSignal.any(signals) : undefined;
        const result = await runReviewOperation(plan, { operation: 'read', path }, { signal });
        await grant?.reassert?.();
        return { output: [{ type: 'text', text: `Committed ${result.path}:\n${result.text}` }] };
      } finally { await grant?.finish?.(); }
    },
  });
  const patch = defineTool({
    name: 'prepare_review', replay: 'unsafe',
    description: 'Prepare a patch on an isolated review branch and run the operator-selected fixed checks. Human review is required.',
    parameters: Type.Object({ patch: Type.String({ maxLength: 262144 }) }),
    async execute({ patch }, api, callContext) {
      const { session, plan } = await authorizedPlan(api.conversationId);
      if (plan.runnerImage) throw new Error('use_delegate_implementation');
      const id = reviewId(api.conversationId, api.callId);
      const branch = `morons-review/${id}`;
      const existing = catalog.getReviewIntent(id);
      const baseRevision = existing ? existing.base_revision :
        (await runReviewOperation(plan, { operation: 'inspect' })).baseRevision;
      const pinnedPlan = (await authorizedPlan(api.conversationId, baseRevision)).plan;
      const grant = await admitOperation?.({ source: session, operation: 'check', branch, baseRevision,
        patch, patchHash: createHash('sha256').update(patch).digest('hex'), signal: callContext.abortSignal });
      if (grant === false) throw new Error('repo_tool_permission_denied');
      try {
        await grant?.reassert?.();
        catalog.reserveReview({ id, sessionId: session.id, branch, patch, baseRevision });
        const signals = [callContext.abortSignal, grant?.signal].filter(Boolean);
        const signal = signals.length ? AbortSignal.any(signals) : undefined;
        const result = await runReviewOperation(pinnedPlan, { operation: 'review', branch, patch, baseRevision }, { signal });
        await grant?.reassert?.();
        const saved = catalog.saveReview({ id, sessionId: session.id, branch, baseRevision: result.baseRevision,
          diff: result.diff, checks: result.checks });
        return { output: [{ type: 'text', text: `Review ${saved.id} prepared on ${branch}. Checks: ${saved.checks.every((check) => check.ok) ? 'passed' : 'failed'}. Human decision pending.` }] };
      } finally { await grant?.finish?.(); }
    },
  });
  return defineExtension({ name: 'repo-review', tools: [source, patch] });
}
