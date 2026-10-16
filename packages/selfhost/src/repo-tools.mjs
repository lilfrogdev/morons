import { createHash } from 'node:crypto';
import { Type } from 'typebox';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import { runReviewOperation } from './review.mjs';

function reviewId(conversationId, callId) {
  return createHash('sha256').update(`${conversationId}:${callId}`).digest('hex').slice(0, 16);
}

export function repoTools(catalog, plan) {
  if (!plan) return null;
  const isRepositorySession = (session) => {
    const moron = session && catalog.getMoron(session.moronId);
    return moron && moron.id === (moron.workspaceId === 'personal' ? 'repo' : `repo-${moron.workspaceId}`);
  };
  const source = defineTool({
    name: 'source_read', replay: 'safe',
    description: 'Read one approved committed source file in the repository.',
    parameters: Type.Object({ path: Type.String({ maxLength: 512 }) }),
    async execute({ path }, api) {
      const session = catalog.getSessionByConversation(api.conversationId);
      if (!isRepositorySession(session)) throw new Error('repo_tool_forbidden');
      const result = await runReviewOperation(plan, { operation: 'read', path });
      return { output: [{ type: 'text', text: `Committed ${result.path}:\n${result.text}` }] };
    },
  });
  const patch = defineTool({
    name: 'prepare_review', replay: 'unsafe',
    description: 'Prepare a patch on an isolated review branch and run the operator-selected fixed checks. Human review is required.',
    parameters: Type.Object({ patch: Type.String({ maxLength: 262144 }) }),
    async execute({ patch }, api) {
      const session = catalog.getSessionByConversation(api.conversationId);
      if (!isRepositorySession(session)) throw new Error('repo_tool_forbidden');
      const id = reviewId(api.conversationId, api.callId);
      const branch = `morons-review/${id}`;
      const existing = catalog.getReviewIntent(id);
      const baseRevision = existing ? existing.base_revision :
        (await runReviewOperation(plan, { operation: 'inspect' })).baseRevision;
      catalog.reserveReview({ id, sessionId: session.id, branch, patch, baseRevision });
      const result = await runReviewOperation(plan, { operation: 'review', branch, patch, baseRevision });
      const saved = catalog.saveReview({ id, sessionId: session.id, branch, baseRevision: result.baseRevision,
        diff: result.diff, checks: result.checks });
      return { output: [{ type: 'text', text: `Review ${saved.id} prepared on ${branch}. Checks: ${saved.checks.every((check) => check.ok) ? 'passed' : 'failed'}. Human decision pending.` }] };
    },
  });
  return defineExtension({ name: 'repo-review', tools: [source, patch] });
}
