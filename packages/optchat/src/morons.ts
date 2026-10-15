import type { RepoMemoryAccess, RepoMemorySource } from "./repo-memory.ts";






export function moronMemoryAccess(input: {
  accountId: string;
  moronId: string;
  sessionId: string;
  allowedSessionIds: readonly string[];
  aclRevision: string;
}): RepoMemoryAccess {
  return {
    projectId: input.accountId,
    repository: input.moronId,
    threadId: input.sessionId,
    actor: input.accountId,
    allowedThreadIds: input.allowedSessionIds,
    revision: input.aclRevision,
  };
}

export function moronMemorySource(
  access: RepoMemoryAccess,
  input: { sourceId: string; kind: string; date: string; text: string },
): RepoMemorySource {
  return {
    sourceId: input.sourceId,
    projectId: access.projectId,
    repository: access.repository,
    threadId: access.threadId,
    kind: input.kind,
    date: input.date,
    text: input.text,
  };
}
