
export interface MemorySql {
  exec<T extends Record<string, string | number | null>>(
    query: string,
    ...bindings: (string | number | null)[]
  ): { toArray(): T[] };
}

/** SQLite adaptation of OptChat's MIT-licensed binary summary tree (v0.7.2).
 * Raw records are authoritative and immutable; derived summaries carry ranges.
 * No author recipe or prompts are included. All operations use the repository DO.
 */
export const REPO_MEMORY_LIMITS = {
  nodeBytes: 512,
  sourceBytes: 131072,
  compressorInputBytes: 16384,
  sourcesPerScope: 4096,
  scopes: 32,
  viewParts: 32,
  pageItems: 32,
  referenceLimit: 256,
  searchScan: 128,


  authorizationScan: 135168,
  storedScopes: 128,
  nodeAttempts: 2,
};
export interface RepoMemorySourceRef {
  sourceId: string;
  projectId: string;
  repository: string;
  threadId: string | null;
  kind: string;
  date: string;

  sequence?: number;
}
export interface RepoMemorySource extends RepoMemorySourceRef {
  text: string;
}
export interface RepoMemoryAccess {
  projectId: string;
  repository: string;
  threadId: string;
  actor: string;
  allowedThreadIds: readonly string[];
  revision?: string;
}
export type RepoMemoryAuthorize = (
  source: RepoMemorySourceRef,
  access: RepoMemoryAccess,
) => boolean;
export interface RepoMemoryReference {
  scopeId: string;
  first: number;
  last: number;
  sourceId?: string;
}
export type RepoMemoryProvenance = RepoMemoryReference;
export interface RepoMemoryItem {
  nodeId: string;
  text: string;
  pending: boolean;
  sourceRefs: RepoMemoryReference[];
}
export interface RepoMemoryPage {
  items: RepoMemoryItem[];
  complete: boolean;
  next?: number;
}
export interface RepoMemoryCompression {
  nodeId: string;
  inputId: string;
  source: string;
  merge: boolean;
  sourceRefs: RepoMemoryReference[];
}
export interface RepoMemoryTurnLimits {
  maxToolCalls?: number;
  maxCompressions?: number;
  maxInputBytes?: number;
  maxOutputBytes?: number;
}
type SqlRow = Record<string, string | number | null>;
type NodeRow = SqlRow & {
  id: string;
  scope: string;
  level: number;
  position: number;
  text: string;
  ready: number;
  attempts: number;
};
type SourceRow = SqlRow & {
  seq: number;
  scope: string;
  position: number;
  body: string;
  metadata: string;
};
type TurnRow = SqlRow & {
  context: string;
  limits: string;
  tools: number;
  compressions: number;
  input: number;
  output: number;
  cutoff: number;
};
type CallRow = SqlRow & { args: string; result: string; accepted: string | null };
const utf8 = (text: string) => new TextEncoder().encode(text).length;
const placeholder = "[Summary pending; zoom this range for original sources.]";
const defaults = {
  maxToolCalls: 12,
  maxCompressions: 4,
  maxInputBytes: 131072,
  maxOutputBytes: 65536,
};
const maxima = {
  maxToolCalls: 32,
  maxCompressions: 8,
  maxInputBytes: 262144,
  maxOutputBytes: 131072,
};
function field(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && utf8(value) <= 256;
}
function integer(value: number, min: number, max: number) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw Error("invalid_memory_range");
  return value;
}
function scope(source: Pick<RepoMemorySourceRef, "projectId" | "repository" | "threadId">) {
  return JSON.stringify([source.projectId, source.repository, source.threadId]);
}
function nodeId(scopeId: string, level: number, position: number) {
  return JSON.stringify([scopeId, level, position]);
}
function reference(node: NodeRow): RepoMemoryReference {
  return {
    scopeId: node.scope,
    first: node.position * 2 ** node.level,
    last: (node.position + 1) * 2 ** node.level,
  };
}
function canonicalAccess(access: RepoMemoryAccess) {
  if (
    !access ||
    ![access.projectId, access.repository, access.threadId, access.actor].every(field) ||
    !Array.isArray(access.allowedThreadIds) ||
    access.allowedThreadIds.length > REPO_MEMORY_LIMITS.scopes ||
    !access.allowedThreadIds.every(field) ||
    (access.revision !== undefined && !field(access.revision))
  )
    throw Error("invalid_memory_access");
  return JSON.stringify({
    projectId: access.projectId,
    repository: access.repository,
    threadId: access.threadId,
    actor: access.actor,
    allowedThreadIds: [...new Set(access.allowedThreadIds)].sort(),
    ...(access.revision !== undefined ? { revision: access.revision } : {}),
  });
}
function summary(value: unknown): value is string {

  return (
    typeof value === "string" &&
    !!value.trim() &&
    utf8(value) <= REPO_MEMORY_LIMITS.nodeBytes &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 && ![9, 10, 13].includes(code);
    }) &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)
  );
}
function generatedSummary(value: unknown): value is string {
  return summary(value) && !/[\r\n]/.test(value);
}

export class RepoMemory {
  private readonly sql: MemorySql;
  private readonly transaction: <T>(work: () => T) => T;
  constructor(
    sql: MemorySql,
    transaction: <T>(work: () => T) => T,
  ) {
    this.sql = sql;
    this.transaction = transaction;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS repo_memory_sources(seq INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT NOT NULL,position INTEGER NOT NULL,source_id TEXT NOT NULL,body TEXT NOT NULL,metadata TEXT NOT NULL,UNIQUE(scope,position),UNIQUE(scope,source_id))",
    );
    sql.exec(
      "CREATE TRIGGER IF NOT EXISTS repo_memory_source_no_update BEFORE UPDATE ON repo_memory_sources BEGIN SELECT RAISE(ABORT,'memory_source_immutable'); END",
    );
    sql.exec(
      "CREATE TRIGGER IF NOT EXISTS repo_memory_source_no_delete BEFORE DELETE ON repo_memory_sources BEGIN SELECT RAISE(ABORT,'memory_source_immutable'); END",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS repo_memory_nodes(id TEXT PRIMARY KEY,scope TEXT NOT NULL,level INTEGER NOT NULL,position INTEGER NOT NULL,text TEXT NOT NULL,ready INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,UNIQUE(scope,level,position))",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS repo_memory_view(scope TEXT NOT NULL,first INTEGER NOT NULL,node_id TEXT NOT NULL,PRIMARY KEY(scope,first))",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS repo_memory_turns(id TEXT PRIMARY KEY,context TEXT NOT NULL,limits TEXT NOT NULL,tools INTEGER NOT NULL DEFAULT 0,compressions INTEGER NOT NULL DEFAULT 0,input INTEGER NOT NULL DEFAULT 0,output INTEGER NOT NULL DEFAULT 0,cutoff INTEGER NOT NULL DEFAULT 0)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS repo_memory_calls(turn_id TEXT NOT NULL,call_id TEXT NOT NULL,args TEXT NOT NULL,result TEXT NOT NULL,accepted TEXT,PRIMARY KEY(turn_id,call_id))",
    );
    sql.exec(
      "CREATE INDEX IF NOT EXISTS repo_memory_pending ON repo_memory_nodes(scope,ready,level,position)",
    );
    const columns = this.rows<{ name: string }>("PRAGMA table_info(repo_memory_nodes)");
    if (!columns.some((column) => column.name === "attempts"))
      sql.exec("ALTER TABLE repo_memory_nodes ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0");
    const turnColumns = this.rows<{ name: string }>("PRAGMA table_info(repo_memory_turns)");
    if (!turnColumns.some((column) => column.name === "cutoff"))
      sql.exec("ALTER TABLE repo_memory_turns ADD COLUMN cutoff INTEGER NOT NULL DEFAULT 0");
    const scopes = this.rows<{ scope: string; n: number; first: number; last: number }>(
      "SELECT scope,count(*) AS n,min(position) AS first,max(position) AS last FROM repo_memory_sources GROUP BY scope LIMIT 129",
    );
    if (scopes.length > REPO_MEMORY_LIMITS.storedScopes) throw Error("invalid_memory_layout");
    for (const stored of scopes) this.validateScope(stored);
    const orphan = this.rows<{ n: number }>(
      "SELECT (SELECT count(*) FROM repo_memory_view WHERE scope NOT IN(SELECT DISTINCT scope FROM repo_memory_sources))+(SELECT count(*) FROM repo_memory_nodes WHERE scope NOT IN(SELECT DISTINCT scope FROM repo_memory_sources)) AS n",
    )[0];
    if (orphan.n) throw Error("invalid_memory_layout");
  }
  private rows<T extends SqlRow>(query: string, ...bindings: (string | number | null)[]) {
    return this.sql.exec<T>(query, ...bindings).toArray();
  }
  private node(id: string) {
    const node = this.rows<NodeRow>("SELECT * FROM repo_memory_nodes WHERE id=?", id)[0];
    if (
      node &&
      (node.id !== nodeId(node.scope, node.level, node.position) ||
        !Number.isSafeInteger(node.level) ||
        node.level < 0 ||
        node.level > 12 ||
        !Number.isSafeInteger(node.position) ||
        node.position < 0 ||
        ![0, 1].includes(node.ready) ||
        (node.ready === 1 && !summary(node.text)))
    )
      throw Error("invalid_memory_layout");
    return node;
  }
  private validateScope(stored: { scope: string; n: number; first: number; last: number }) {
    if (
      stored.n < 1 ||
      stored.n > REPO_MEMORY_LIMITS.sourcesPerScope ||
      stored.first !== 0 ||
      stored.last !== stored.n - 1
    )
      throw Error("invalid_memory_layout");
    const view = this.rows<
      SqlRow & {
        first: number;
        node_id: string;
        id: string | null;
        scope: string | null;
        level: number | null;
        position: number | null;
        text: string | null;
        ready: number | null;
      }
    >(
      "SELECT v.first,v.node_id,n.* FROM repo_memory_view v LEFT JOIN repo_memory_nodes n ON n.id=v.node_id WHERE v.scope=? ORDER BY v.first LIMIT 33",
      stored.scope,
    );
    if (!view.length || view.length > REPO_MEMORY_LIMITS.viewParts)
      throw Error("invalid_memory_layout");
    let covered = 0;
    for (const row of view) {
      if (
        !row.id ||
        row.scope !== stored.scope ||
        row.level === null ||
        row.position === null ||
        row.first !== covered ||
        row.position * 2 ** row.level !== covered ||
        row.node_id !== nodeId(stored.scope, row.level, row.position) ||
        row.text === null ||
        utf8(row.text) > REPO_MEMORY_LIMITS.nodeBytes ||
        (row.ready === 1 && !summary(row.text)) ||
        ![0, 1].includes(row.ready!)
      )
        throw Error("invalid_memory_layout");
      covered += 2 ** row.level;
    }
    if (covered !== stored.n) throw Error("invalid_memory_layout");
    let expected = 0;
    for (let n = stored.n; n > 0; n = Math.floor(n / 2)) expected += n;
    const count = this.rows<{ n: number; invalid: number }>(
      "SELECT count(*) AS n,sum(CASE WHEN typeof(level)<>'integer' OR typeof(position)<>'integer' OR level<0 OR level>12 OR position<0 OR (position+1)*(1<<level)>? OR ready NOT IN(0,1) OR attempts<0 OR attempts>2 OR length(CAST(text AS BLOB))>512 THEN 1 ELSE 0 END) AS invalid FROM repo_memory_nodes WHERE scope=?",
      stored.n,
      stored.scope,
    )[0];
    if (count.n !== expected || count.invalid) throw Error("invalid_memory_layout");
  }
  append(source: RepoMemorySource) {
    if (
      !source ||
      ![source.sourceId, source.projectId, source.repository, source.kind, source.date].every(
        field,
      ) ||
      (source.threadId !== null && !field(source.threadId)) ||
      typeof source.text !== "string" ||
      utf8(source.text) > REPO_MEMORY_LIMITS.sourceBytes
    )
      throw Error("invalid_memory_source");
    const normalized: RepoMemorySource = {
      sourceId: source.sourceId,
      projectId: source.projectId,
      repository: source.repository,
      threadId: source.threadId,
      kind: source.kind,
      date: source.date,
      text: source.text,
    };
    const { text: _text, ...metadata } = normalized;
    const scopeId = scope(source),
      body = JSON.stringify(normalized);
    return this.transaction(() => {
      const existing = this.rows<SourceRow>(
        "SELECT * FROM repo_memory_sources WHERE scope=? AND source_id=?",
        scopeId,
        source.sourceId,
      )[0];
      if (existing) {
        if (existing.body !== body) throw Error("memory_source_conflict");
        return { index: existing.position, nodeId: nodeId(scopeId, 0, existing.position) };
      }
      const count = this.rows<{ n: number }>(
        "SELECT count(*) AS n FROM repo_memory_sources WHERE scope=?",
        scopeId,
      )[0].n;
      if (count >= REPO_MEMORY_LIMITS.sourcesPerScope) throw Error("memory_source_capacity");
      if (
        !count &&
        this.rows<{ n: number }>("SELECT count(DISTINCT scope) AS n FROM repo_memory_sources")[0]
          .n >= REPO_MEMORY_LIMITS.storedScopes
      )
        throw Error("memory_scope_capacity");
      this.sql.exec(
        "INSERT INTO repo_memory_sources(scope,position,source_id,body,metadata) VALUES(?,?,?,?,?)",
        scopeId,
        count,
        source.sourceId,
        body,
        JSON.stringify(metadata),
      );
      let level = 0,
        position = count;
      const leafId = nodeId(scopeId, 0, count),
        ready = summary(source.text);
      this.sql.exec(
        "INSERT INTO repo_memory_nodes(id,scope,level,position,text,ready) VALUES(?,?,?,?,?,?)",
        leafId,
        scopeId,
        level,
        position,
        ready ? source.text : placeholder,
        ready ? 1 : 0,
      );
      this.sql.exec("INSERT INTO repo_memory_view VALUES(?,?,?)", scopeId, count, leafId);
      while (position % 2 === 1) {
        const left = this.node(nodeId(scopeId, level, position - 1))!,
          right = this.node(nodeId(scopeId, level, position))!;
        const text = `${left.text}\n${right.text}`;
        const built = left.ready === 1 && right.ready === 1 && summary(text);
        position = Math.floor(position / 2);
        level++;
        this.sql.exec(
          "INSERT INTO repo_memory_nodes(id,scope,level,position,text,ready) VALUES(?,?,?,?,?,?)",
          nodeId(scopeId, level, position),
          scopeId,
          level,
          position,
          built ? text : placeholder,
          built ? 1 : 0,
        );
      }
      this.fit(scopeId);
      return { index: count, nodeId: leafId };
    });
  }

  sourceInventory(access: RepoMemoryAccess, authorize: RepoMemoryAuthorize) {
    const scopes = this.scopes(access).slice(1);
    const rows = this.rows<{ source_id: string; metadata: string; seq: number }>(
      `SELECT source_id,metadata,seq FROM repo_memory_sources WHERE scope IN (${scopes.map(() => "?").join(",")}) LIMIT 131073`,
      ...scopes,
    );
    if (rows.length > REPO_MEMORY_LIMITS.scopes * REPO_MEMORY_LIMITS.sourcesPerScope)
      throw Error("memory_source_capacity");
    for (const row of rows)
      if (!authorize({ ...JSON.parse(row.metadata), sequence: row.seq }, access))
        throw Error("memory_access_denied");
    return { sourceIds: new Set(rows.map((row) => row.source_id)), count: rows.length };
  }
  private fit(scopeId: string) {
    let parts = this.rows<NodeRow>(
      "SELECT n.* FROM repo_memory_view v JOIN repo_memory_nodes n ON n.id=v.node_id WHERE v.scope=? ORDER BY v.first",
      scopeId,
    );
    while (parts.length > REPO_MEMORY_LIMITS.viewParts) {
      const at = parts.findIndex(
        (part, index) =>
          part.position % 2 === 0 &&
          parts[index + 1]?.level === part.level &&
          parts[index + 1]?.position === part.position + 1,
      );
      if (at < 0) throw Error("memory_view_capacity");
      const left = parts[at],
        right = parts[at + 1],
        parent = this.node(nodeId(scopeId, left.level + 1, left.position / 2))!;
      this.sql.exec(
        "DELETE FROM repo_memory_view WHERE scope=? AND first IN (?,?)",
        scopeId,
        reference(left).first,
        reference(right).first,
      );
      this.sql.exec(
        "INSERT INTO repo_memory_view VALUES(?,?,?)",
        scopeId,
        reference(parent).first,
        parent.id,
      );
      parts.splice(at, 2, parent);
    }
  }
  beginTurn(turnId: string, access: RepoMemoryAccess, limits: RepoMemoryTurnLimits = {}) {
    if (!field(turnId)) throw Error("invalid_memory_turn");
    const context = canonicalAccess(access),
      bounded = { ...defaults, ...limits };
    if (Object.keys(bounded).some((key) => !(key in defaults)))
      throw Error("invalid_memory_budget");
    for (const key of Object.keys(defaults) as (keyof typeof defaults)[])
      integer(bounded[key], 0, maxima[key]);
    const serialized = JSON.stringify(bounded);
    this.transaction(() => {
      const row = this.rows<TurnRow>("SELECT * FROM repo_memory_turns WHERE id=?", turnId)[0];
      if (row && (row.context !== context || row.limits !== serialized))
        throw Error("memory_turn_conflict");
      this.sql.exec(
        "INSERT OR IGNORE INTO repo_memory_turns(id,context,limits,cutoff) VALUES(?,?,?,?)",
        turnId,
        context,
        serialized,
        this.rows<{ n: number }>("SELECT coalesce(max(seq),0) AS n FROM repo_memory_sources")[0].n,
      );
    });
  }
  private turn(turnId: string, access: RepoMemoryAccess) {
    const row = this.rows<TurnRow>("SELECT * FROM repo_memory_turns WHERE id=?", turnId)[0];
    if (!row || row.context !== canonicalAccess(access)) throw Error("memory_turn_conflict");
    return row;
  }
  private scopes(access: RepoMemoryAccess) {
    canonicalAccess(access);
    return [...new Set([null, ...access.allowedThreadIds])].map((threadId) =>
      scope({ ...access, threadId }),
    );
  }
  assertReferences(
    access: RepoMemoryAccess,
    authorize: RepoMemoryAuthorize,
    refs: readonly RepoMemoryReference[],
  ) {
    if (!Array.isArray(refs) || refs.length > REPO_MEMORY_LIMITS.referenceLimit)
      throw Error("invalid_memory_reference");
    const scopes = this.scopes(access);
    const groups = new Map<string, RepoMemoryReference[]>();
    for (const ref of refs) {
      if (!ref || typeof ref.scopeId !== "string" || !scopes.includes(ref.scopeId))
        throw Error("memory_access_denied");
      integer(ref.first, 0, REPO_MEMORY_LIMITS.sourcesPerScope - 1);
      integer(ref.last, ref.first + 1, REPO_MEMORY_LIMITS.sourcesPerScope);
      if (ref.sourceId !== undefined && (ref.last - ref.first !== 1 || !field(ref.sourceId)))
        throw Error("invalid_memory_reference");
      const group = groups.get(ref.scopeId) ?? [];
      group.push(ref);
      groups.set(ref.scopeId, group);
    }
    let scanned = 0;
    for (const [scopeId, group] of groups) {
      const merged: { first: number; last: number }[] = [];
      for (const ref of [...group].sort((a, b) => a.first - b.first)) {
        const previous = merged.at(-1);
        if (previous && ref.first <= previous.last)
          previous.last = Math.max(previous.last, ref.last);
        else merged.push({ first: ref.first, last: ref.last });
      }
      for (const range of merged) {
        scanned += range.last - range.first;
        if (scanned > REPO_MEMORY_LIMITS.authorizationScan)
          throw Error("memory_authorization_capacity");
        const rows = this.rows<{ position: number; metadata: string; seq: number }>(
          "SELECT position,metadata,seq FROM repo_memory_sources WHERE scope=? AND position>=? AND position<? ORDER BY position LIMIT 4096",
          scopeId,
          range.first,
          range.last,
        );
        if (rows.length !== range.last - range.first) throw Error("invalid_memory_reference");
        for (const row of rows) {
          const source = { ...JSON.parse(row.metadata), sequence: row.seq } as RepoMemorySourceRef;
          if (
            group.some(
              (ref) =>
                ref.sourceId !== undefined &&
                ref.first === row.position &&
                ref.sourceId !== source.sourceId,
            ) ||
            !authorize(source, access)
          )
            throw Error("memory_access_denied");
        }
      }
    }
  }
  private item(node: NodeRow): RepoMemoryItem {
    return {
      nodeId: node.id,
      text: node.text,
      pending: !node.ready,
      sourceRefs: [reference(node)],
    };
  }
  private turnAuthorize(turn: TurnRow, authorize: RepoMemoryAuthorize): RepoMemoryAuthorize {
    return (source, access) =>
      source.sequence !== undefined && source.sequence <= turn.cutoff && authorize(source, access);
  }
  assertTurnReferences(
    turnId: string,
    access: RepoMemoryAccess,
    authorize: RepoMemoryAuthorize,
    refs: readonly RepoMemoryReference[],
  ) {
    this.assertReferences(access, this.turnAuthorize(this.turn(turnId, access), authorize), refs);
  }


  assertSnapshotReferences(
    turnId: string,
    currentAccess: RepoMemoryAccess,
    authorize: RepoMemoryAuthorize,
    refs: readonly RepoMemoryReference[],
  ) {
    canonicalAccess(currentAccess);
    const snapshot = this.rows<TurnRow>("SELECT * FROM repo_memory_turns WHERE id=?", turnId)[0];
    if (!snapshot) throw Error("memory_snapshot_conflict");
    const original = JSON.parse(snapshot.context) as RepoMemoryAccess;
    if (
      canonicalAccess(original) !== snapshot.context ||
      original.projectId !== currentAccess.projectId ||
      original.repository !== currentAccess.repository ||
      original.threadId !== currentAccess.threadId ||
      original.revision !== currentAccess.revision
    )
      throw Error("memory_snapshot_conflict");


    const admittedScopes = this.scopes(original);
    if (!Array.isArray(refs) || refs.length > REPO_MEMORY_LIMITS.referenceLimit)
      throw Error("invalid_memory_reference");
    if (refs.some((ref) => !ref || !admittedScopes.includes(ref.scopeId)))
      throw Error("memory_access_denied");
    this.assertReferences(currentAccess, this.turnAuthorize(snapshot, authorize), refs);
  }
  private charge(
    turnId: string,
    row: TurnRow,
    input: number,
    output: number,
    compression: boolean,
  ) {
    this.checkBudget(row, input, output, compression);
    this.sql.exec(
      "UPDATE repo_memory_turns SET tools=tools+1,input=input+?,output=output+?,compressions=compressions+? WHERE id=?",
      input,
      output,
      compression ? 1 : 0,
      turnId,
    );
  }
  private checkBudget(row: TurnRow, input: number, output: number, compression: boolean) {
    const limits = JSON.parse(row.limits) as typeof defaults;
    if (
      row.tools + 1 > limits.maxToolCalls ||
      row.input + input > limits.maxInputBytes ||
      row.output + output > limits.maxOutputBytes ||
      (compression && row.compressions + 1 > limits.maxCompressions)
    )
      throw Error("memory_turn_budget");
  }
  private read(
    turnId: string,
    callId: string,
    access: RepoMemoryAccess,
    authorize: RepoMemoryAuthorize,
    args: unknown,
    work: (authorize: RepoMemoryAuthorize, cutoff: number) => RepoMemoryPage,
  ) {
    if (!field(callId)) throw Error("invalid_memory_call");
    const serialized = JSON.stringify(args);
    const outcome = this.transaction(() => {
      const turn = this.turn(turnId, access),
        old = this.rows<CallRow>(
          "SELECT * FROM repo_memory_calls WHERE turn_id=? AND call_id=?",
          turnId,
          callId,
        )[0];
      if (old && old.args !== serialized) throw Error("memory_call_conflict");
      if (!old) this.charge(turnId, turn, utf8(serialized), 0, false);
      try {
        const boundedAuthorize = this.turnAuthorize(turn, authorize);
        const result = old
          ? (JSON.parse(old.result) as RepoMemoryPage & { error?: string })
          : work(boundedAuthorize, turn.cutoff);
        if ("error" in result) return { error: result.error! };
        this.assertReferences(
          access,
          boundedAuthorize,
          result.items.flatMap((item) => item.sourceRefs),
        );
        if (!old) {
          const body = JSON.stringify(result),
            size = utf8(body);
          const limits = JSON.parse(turn.limits) as typeof defaults;
          if (turn.output + size > limits.maxOutputBytes) throw Error("memory_turn_budget");
          this.sql.exec("UPDATE repo_memory_turns SET output=output+? WHERE id=?", size, turnId);
          this.sql.exec(
            "INSERT INTO repo_memory_calls(turn_id,call_id,args,result) VALUES(?,?,?,?)",
            turnId,
            callId,
            serialized,
            body,
          );
        }
        return { result };
      } catch (error) {
        const code =
          error instanceof Error && /^(?:invalid_memory_|memory_)[a-z_]+$/.test(error.message)
            ? error.message
            : "memory_read_failed";


        if (!old)
          this.sql.exec(
            "INSERT INTO repo_memory_calls(turn_id,call_id,args,result) VALUES(?,?,?,?)",
            turnId,
            callId,
            serialized,
            JSON.stringify({ error: code }),
          );
        return { error: code };
      }
    });
    if ("error" in outcome) throw Error(String(outcome.error));
    return outcome.result;
  }
  view(
    turnId: string,
    callId: string,
    access: RepoMemoryAccess,
    authorize: RepoMemoryAuthorize,
    options: { offset?: number; limit?: number } = {},
  ) {
    const offset = integer(options.offset ?? 0, 0, REPO_MEMORY_LIMITS.authorizationScan),
      limit = integer(options.limit ?? 16, 1, REPO_MEMORY_LIMITS.pageItems);
    return this.read(
      turnId,
      callId,
      access,
      authorize,
      { type: "view", offset, limit },
      (boundedAuthorize) => {
        const scopes = this.scopes(access),
          nodes = this.rows<NodeRow>(
            `SELECT n.* FROM repo_memory_view v JOIN repo_memory_nodes n ON n.id=v.node_id WHERE v.scope IN (${scopes.map(() => "?").join(",")}) ORDER BY v.scope,v.first LIMIT 1057`,
            ...scopes,
          );
        const storedScopes = this.rows<{ scope: string; n: number; first: number; last: number }>(
          `SELECT scope,count(*) AS n,min(position) AS first,max(position) AS last FROM repo_memory_sources WHERE scope IN (${scopes.map(() => "?").join(",")}) GROUP BY scope LIMIT 33`,
          ...scopes,
        );
        for (const stored of storedScopes) this.validateScope(stored);
        const visible: NodeRow[] = [];
        let scanned = 0;
        for (const root of nodes) {
          const ref = reference(root);
          scanned += ref.last - ref.first;
          if (scanned > REPO_MEMORY_LIMITS.authorizationScan)
            throw Error("memory_authorization_capacity");
          const metadata = this.rows<{ position: number; seq: number; metadata: string }>(
            "SELECT position,seq,metadata FROM repo_memory_sources WHERE scope=? AND position>=? AND position<? ORDER BY position LIMIT 4096",
            root.scope,
            ref.first,
            ref.last,
          );
          if (metadata.length !== ref.last - ref.first) throw Error("invalid_memory_layout");
          const denied = [0];
          for (const row of metadata)
            denied.push(
              denied[denied.length - 1] +
                (boundedAuthorize({ ...JSON.parse(row.metadata), sequence: row.seq }, access)
                  ? 0
                  : 1),
            );
          const visit = (node: NodeRow) => {
            const range = reference(node),
              first = range.first - ref.first,
              last = range.last - ref.first,
              count = denied[last] - denied[first];
            if (!count) {
              visible.push(node);
              return;
            }
            if (count === last - first) return;
            if (!node.level) throw Error("invalid_memory_layout");
            for (const delta of [0, 1]) {
              const child = this.node(
                nodeId(node.scope, node.level - 1, node.position * 2 + delta),
              );
              if (!child) throw Error("invalid_memory_layout");
              visit(child);
            }
          };
          visit(root);
        }
        const complete = visible.length <= offset + limit;
        return {
          items: visible.slice(offset, offset + limit).map((node) => this.item(node)),
          complete,
          ...(!complete ? { next: offset + limit } : {}),
        };
      },
    );
  }
  search(
    turnId: string,
    callId: string,
    access: RepoMemoryAccess,
    authorize: RepoMemoryAuthorize,
    options: { query: string; before?: number; limit?: number },
  ) {
    if (
      !options ||
      typeof options.query !== "string" ||
      !options.query.trim() ||
      utf8(options.query) > 128
    )
      throw Error("invalid_memory_query");
    const before = integer(options.before ?? Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER),
      limit = integer(options.limit ?? 8, 1, REPO_MEMORY_LIMITS.pageItems);
    return this.read(
      turnId,
      callId,
      access,
      authorize,
      { type: "search", ...options, before, limit },
      (boundedAuthorize, cutoff) => {
        const scopes = this.scopes(access),
          rows = this.rows<SourceRow>(
            `SELECT * FROM repo_memory_sources WHERE scope IN (${scopes.map(() => "?").join(",")}) AND seq<? AND seq<=? ORDER BY seq DESC LIMIT ?`,
            ...scopes,
            before,
            cutoff,
            REPO_MEMORY_LIMITS.searchScan + 1,
          );
        const items: RepoMemoryItem[] = [];
        let next = before,
          processed = 0;
        for (const row of rows.slice(0, REPO_MEMORY_LIMITS.searchScan)) {
          processed++;
          next = row.seq;
          const source = JSON.parse(row.body) as RepoMemorySource;
          if (!source.text.toLocaleLowerCase().includes(options.query.toLocaleLowerCase()))
            continue;
          const refs = [
            {
              scopeId: row.scope,
              first: row.position,
              last: row.position + 1,
              sourceId: source.sourceId,
            },
          ];
          try {
            this.assertReferences(access, boundedAuthorize, refs);
          } catch (error) {
            if (error instanceof Error && error.message === "memory_access_denied") continue;
            throw error;
          }
          const at = source.text.toLocaleLowerCase().indexOf(options.query.toLocaleLowerCase());
          items.push({
            nodeId: nodeId(row.scope, 0, row.position),
            text: source.text.slice(Math.max(0, at - 80), at + 240),
            pending: false,
            sourceRefs: refs,
          });
          if (items.length === limit) break;
        }
        const complete = processed === rows.length;
        return { items, complete, ...(!complete ? { next } : {}) };
      },
    );
  }
  zoom(
    turnId: string,
    callId: string,
    access: RepoMemoryAccess,
    authorize: RepoMemoryAuthorize,
    options: { nodeId: string; offset?: number; limit?: number },
  ) {
    if (!options || typeof options.nodeId !== "string" || utf8(options.nodeId) > 2048)
      throw Error("invalid_memory_node");
    const offset = integer(options.offset ?? 0, 0, REPO_MEMORY_LIMITS.sourceBytes),
      limit = integer(options.limit ?? 1024, 1, 2048);
    return this.read(
      turnId,
      callId,
      access,
      authorize,
      { type: "zoom", ...options, offset, limit },
      (boundedAuthorize) => {
        const node = this.node(options.nodeId);
        if (!node) throw Error("invalid_memory_node");
        this.assertReferences(access, boundedAuthorize, [reference(node)]);
        if (node.level) {
          if (offset) throw Error("invalid_memory_range");
          return {
            items: [0, 1].map((delta) =>
              this.item(this.node(nodeId(node.scope, node.level - 1, node.position * 2 + delta))!),
            ),
            complete: true,
          };
        }
        const row = this.rows<SourceRow>(
            "SELECT * FROM repo_memory_sources WHERE scope=? AND position=?",
            node.scope,
            node.position,
          )[0],
          source = JSON.parse(row.body) as RepoMemorySource;
        if (offset > source.text.length) throw Error("invalid_memory_range");
        let end = Math.min(offset + limit, source.text.length);
        if (end < source.text.length && /[\uD800-\uDBFF]/.test(source.text[end - 1])) {
          if (end - offset === 1) end++;
          else end--;
        }
        if (offset && /[\uDC00-\uDFFF]/.test(source.text[offset]))
          throw Error("invalid_memory_range");
        const complete = end === source.text.length;
        return {
          items: [
            {
              nodeId: node.id,
              text: source.text.slice(offset, end),
              pending: false,
              sourceRefs: [{ ...reference(node), sourceId: source.sourceId }],
            },
          ],
          complete,
          ...(!complete ? { next: end } : {}),
        };
      },
    );
  }
  private compressionSource(node: NodeRow) {
    if (!node.level) {
      const row = this.rows<SourceRow>(
        "SELECT * FROM repo_memory_sources WHERE scope=? AND position=?",
        node.scope,
        node.position,
      )[0];
      return (JSON.parse(row.body) as RepoMemorySource).text;
    }
    const left = this.node(nodeId(node.scope, node.level - 1, node.position * 2))!,
      right = this.node(nodeId(node.scope, node.level - 1, node.position * 2 + 1))!;
    if (!left || !right) throw Error("invalid_memory_layout");
    return left.ready && right.ready ? `${left.text}\n${right.text}` : undefined;
  }
  async nextCompression(
    turnId: string,
    callId: string,
    access: RepoMemoryAccess,
    authorize: RepoMemoryAuthorize,
  ): Promise<RepoMemoryCompression | undefined> {
    if (!field(callId)) throw Error("invalid_memory_call");
    const turn = this.turn(turnId, access);
    const boundedAuthorize = this.turnAuthorize(turn, authorize);
    const args = JSON.stringify({ type: "compression" });
    const old = this.rows<CallRow>(
      "SELECT * FROM repo_memory_calls WHERE turn_id=? AND call_id=?",
      turnId,
      callId,
    )[0];
    if (old) {
      if (old.args !== args) throw Error("memory_call_conflict");
      return undefined;
    }
    this.checkBudget(turn, 0, 0, true);
    const scopes = this.scopes(access),
      candidates = this.rows<NodeRow>(
        `SELECT * FROM repo_memory_nodes WHERE scope IN (${scopes.map(() => "?").join(",")}) AND ready=0 AND attempts<2 ORDER BY level,position LIMIT 128`,
        ...scopes,
      );
    let node: NodeRow | undefined, source: string | undefined;
    for (const candidate of candidates) {
      const input = this.compressionSource(candidate);
      if (input === undefined || utf8(input) > REPO_MEMORY_LIMITS.compressorInputBytes) continue;
      try {
        this.assertReferences(access, boundedAuthorize, [reference(candidate)]);
      } catch (error) {
        if (error instanceof Error && error.message === "memory_access_denied") continue;
        throw error;
      }
      node = candidate;
      source = input;
      break;
    }
    if (!node || source === undefined) {
      this.transaction(() => {
        const currentTurn = this.turn(turnId, access),
          duplicate = this.rows<CallRow>(
            "SELECT * FROM repo_memory_calls WHERE turn_id=? AND call_id=?",
            turnId,
            callId,
          )[0];
        if (duplicate) {
          if (duplicate.args !== args) throw Error("memory_call_conflict");
          return;
        }
        this.charge(turnId, currentTurn, 0, 0, false);
        this.sql.exec(
          "INSERT INTO repo_memory_calls(turn_id,call_id,args,result) VALUES(?,?,?,?)",
          turnId,
          callId,
          args,
          "null",
        );
      });
      return undefined;
    }
    const frozen = node,
      frozenSource = source;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify([node.id, source])),
    );
    const inputId = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return this.transaction(() => {
      const turn = this.turn(turnId, access),
        duplicate = this.rows<CallRow>(
          "SELECT * FROM repo_memory_calls WHERE turn_id=? AND call_id=?",
          turnId,
          callId,
        )[0];
      if (duplicate) {
        if (duplicate.args !== args) throw Error("memory_call_conflict");
        return undefined;
      }
      const current = this.node(frozen.id)!;
      if (
        current.ready ||
        current.attempts >= REPO_MEMORY_LIMITS.nodeAttempts ||
        this.compressionSource(current) !== frozenSource
      )
        return undefined;
      this.assertReferences(access, this.turnAuthorize(turn, authorize), [reference(current)]);
      const result: RepoMemoryCompression = {
        nodeId: current.id,
        inputId,
        source: frozenSource,
        merge: current.level > 0,
        sourceRefs: [reference(current)],
      };


      this.charge(turnId, turn, utf8(frozenSource), REPO_MEMORY_LIMITS.nodeBytes, true);
      this.sql.exec("UPDATE repo_memory_nodes SET attempts=attempts+1 WHERE id=?", current.id);
      this.sql.exec(
        "INSERT INTO repo_memory_calls(turn_id,call_id,args,result) VALUES(?,?,?,?)",
        turnId,
        callId,
        args,
        JSON.stringify(result),
      );
      return result;
    });
  }
  acceptSummary(
    turnId: string,
    callId: string,
    access: RepoMemoryAccess,
    authorize: RepoMemoryAuthorize,
    input: { nodeId: string; inputId: string; text: string },
  ) {
    if (!input || !generatedSummary(input.text)) throw Error("invalid_memory_summary");
    return this.transaction(() => {
      const turn = this.turn(turnId, access);
      const claim = this.rows<CallRow>(
        "SELECT * FROM repo_memory_calls WHERE turn_id=? AND call_id=?",
        turnId,
        callId,
      )[0];
      if (!claim || claim.args !== JSON.stringify({ type: "compression" }))
        throw Error("invalid_memory_claim");
      const frozen = JSON.parse(claim.result) as RepoMemoryCompression;
      if (!frozen || input.nodeId !== frozen.nodeId || input.inputId !== frozen.inputId)
        throw Error("invalid_memory_claim");
      this.assertReferences(access, this.turnAuthorize(turn, authorize), frozen.sourceRefs);
      if (claim.accepted !== null) {
        if (claim.accepted !== input.text) throw Error("memory_summary_conflict");
        return;
      }
      const node = this.node(input.nodeId)!;
      if (
        node.ready ||
        this.compressionSource(node) !== frozen.source ||
        utf8(input.text) >= utf8(frozen.source)
      )
        throw Error("memory_summary_conflict");
      this.sql.exec(
        "UPDATE repo_memory_nodes SET text=?,ready=1 WHERE id=? AND ready=0",
        input.text,
        input.nodeId,
      );
      this.sql.exec(
        "UPDATE repo_memory_calls SET accepted=? WHERE turn_id=? AND call_id=?",
        input.text,
        turnId,
        callId,
      );
    });
  }
}
