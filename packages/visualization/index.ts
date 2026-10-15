/** Data-only visualization contract. Model output may only enter through parseDraft. */
export const VISUALIZATION_VERSION = 1 as const;
const MAX_DOCUMENT_BYTES = 32768;
const encoder = new TextEncoder();

export type ChartDraft = {
  kind: "bar" | "line";
  title: string;
  xLabel: string;
  yLabel: string;
  points: { label: string; value: number }[];
};
export type TableDraft = {
  kind: "table";
  title: string;
  columns: string[];
  rows: string[][];
};
/** A native-renderable subset of Pitcrew's Apache-2.0 structured document dialect. */
export type DocumentNode = { text: string } | {
  tag: "section" | "p" | "span" | "h2" | "h3" | "strong" | "em" | "small" |
    "code" | "pre" | "ul" | "ol" | "li" | "br" | "hr";
  children?: DocumentNode[];
};
export type DocumentDraft = { kind: "document"; title: string; summary: string; nodes: DocumentNode[] };
export type VisualizationDraft = ChartDraft | TableDraft | DocumentDraft;

export type VisualizationDocument = {
  version: typeof VISUALIZATION_VERSION;
  id: string;
  accountId: string;
  threadId: string;
  sourceMessageId: string;
  sourceRevision: string;
  createdAt: number;
  content: VisualizationDraft;
};

/** These fields must come from authenticated server state, never from model output. */
export type TrustedOrigin = Omit<VisualizationDocument, "version" | "content">;

/** Values must be loaded afresh from the account/thread/document store on every read. */
export type ReadAuthority = {
  accountId: string;
  threadId: string;
  threadOwnerAccountId: string;
  sourceMessageId: string;
  currentSourceRevision: string;
  activeSession: boolean;
  sourceMessageExists: boolean;
  documentRevoked: boolean;
  /** Changes on logout, membership change, or session replacement. */
  accessEpoch?: string;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === allowed.length && actual.every((key) => allowed.includes(key));
}

function text(value: unknown, max: number): value is string {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function fail(): never {
  throw new Error("Invalid visualization document");
}

const DOCUMENT_TAGS = new Set([
  "section", "p", "span", "h2", "h3", "strong", "em", "small",
  "code", "pre", "ul", "ol", "li", "br", "hr",
]);
function parseNode(value: unknown, depth: number, count: { value: number }): DocumentNode {
  if (++count.value > 512 || depth > 12 || !record(value)) fail();
  if ("text" in value) {
    if (!keys(value, ["text"]) || typeof value.text !== "string" ||
      value.text.length > 4096 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value.text)) fail();
    return { text: value.text };
  }
  if (!keys(value, ["tag", "children"]) && !keys(value, ["tag"])) fail();
  if (typeof value.tag !== "string" || !DOCUMENT_TAGS.has(value.tag)) fail();
  if (value.children !== undefined && !Array.isArray(value.children)) fail();
  if ((value.tag === "br" || value.tag === "hr") && value.children !== undefined) fail();
  return { tag: value.tag as Exclude<DocumentNode, { text: string }>["tag"],
    ...(value.children === undefined ? {} : {
      children: (value.children as unknown[]).map((child) => parseNode(child, depth + 1, count)),
    }) };
}

/** Rejects executable formats, unknown fields, nonfinite numbers, and excessive payloads. */
export function parseDraft(value: unknown): VisualizationDraft {
  if (!record(value)) fail();
  if (encoder.encode(JSON.stringify(value)).byteLength > MAX_DOCUMENT_BYTES) fail();
  if (value.kind === "bar" || value.kind === "line") {
    if (!keys(value, ["kind", "title", "xLabel", "yLabel", "points"]) ||
      !text(value.title, 120) || !text(value.xLabel, 80) || !text(value.yLabel, 80) ||
      !Array.isArray(value.points) || value.points.length < 1 || value.points.length > 128) fail();
    const points = value.points.map((point: unknown) => {
      if (!record(point) || !keys(point, ["label", "value"]) ||
        !text(point.label, 80) || typeof point.value !== "number" ||
        !Number.isFinite(point.value)) fail();
      return { label: point.label as string, value: point.value as number };
    });
    return { kind: value.kind, title: value.title, xLabel: value.xLabel,
      yLabel: value.yLabel, points };
  }
  if (value.kind === "table") {
    if (!keys(value, ["kind", "title", "columns", "rows"]) ||
      !text(value.title, 120) || !Array.isArray(value.columns) ||
      value.columns.length < 1 || value.columns.length > 12 ||
      !value.columns.every((column: unknown) => text(column, 80)) ||
      !Array.isArray(value.rows) || value.rows.length > 128) fail();
    const columns = value.columns as string[];
    const rows = value.rows.map((row: unknown) => {
      if (!Array.isArray(row) || row.length !== columns.length ||
        !row.every((cell: unknown) => text(cell, 256))) fail();
      return [...row] as string[];
    });
    return { kind: "table", title: value.title, columns: [...columns], rows };
  }
  if (value.kind === "document") {
    if (!keys(value, ["kind", "title", "summary", "nodes"]) ||
      !text(value.title, 120) || !text(value.summary, 2000) ||
      !Array.isArray(value.nodes) || value.nodes.length < 1) fail();
    const count = { value: 0 };
    return { kind: "document", title: value.title, summary: value.summary,
      nodes: value.nodes.map((node: unknown) => parseNode(node, 1, count)) };
  }
  return fail();
}

/** Only the server can attach provenance after checking the source message. */
export function sealDocument(input: unknown, origin: TrustedOrigin): VisualizationDocument {
  const content = parseDraft(input);
  if (!record(origin) ||
    !keys(origin, ["id", "accountId", "threadId", "sourceMessageId", "sourceRevision", "createdAt"]) ||
    ![origin.id, origin.accountId, origin.threadId, origin.sourceMessageId,
    origin.sourceRevision].every((v) => text(v, 128)) ||
    !Number.isSafeInteger(origin.createdAt) || origin.createdAt <= 0) fail();
  return { ...origin, version: VISUALIZATION_VERSION, content };
}

/** Fail closed; caller must fetch ReadAuthority from trusted storage, never the request body. */
export function canReadDocument(doc: VisualizationDocument, auth: ReadAuthority): boolean {
  return doc.version === VISUALIZATION_VERSION &&
    auth.activeSession === true && auth.sourceMessageExists === true &&
    auth.documentRevoked === false &&
    doc.accountId === auth.accountId &&
    doc.accountId === auth.threadOwnerAccountId &&
    doc.threadId === auth.threadId &&
    doc.sourceMessageId === auth.sourceMessageId &&
    doc.sourceRevision === auth.currentSourceRevision;
}

/** Short-lived server authority; generated content never grants its own visibility. */
export type VisualizationEnvelope = {
  accountId: string;
  threadId: string;
  accessEpoch: string;
  leaseMs: number;
  documents: VisualizationDocument[];
};

export function parseEnvelope(value: unknown): VisualizationEnvelope {
  if (!record(value) || !keys(value, ["accountId", "threadId", "accessEpoch", "leaseMs", "documents"]) ||
    !text(value.accountId, 128) || !text(value.threadId, 128) ||
    !text(value.accessEpoch, 128) || !Number.isInteger(value.leaseMs) ||
    (value.leaseMs as number) < 1 || (value.leaseMs as number) > 5000 ||
    !Array.isArray(value.documents) || value.documents.length > 10 ||
    encoder.encode(JSON.stringify(value)).byteLength > 524288) fail();
  const documents = (value.documents as unknown[]).map((input) => {
    if (!record(input) || !keys(input, ["version", "id", "accountId", "threadId", "sourceMessageId", "sourceRevision", "createdAt", "content"]) ||
      input.version !== VISUALIZATION_VERSION) fail();
    const origin = { id: input.id, accountId: input.accountId, threadId: input.threadId,
      sourceMessageId: input.sourceMessageId, sourceRevision: input.sourceRevision,
      createdAt: input.createdAt } as TrustedOrigin;
    const document = sealDocument(input.content, origin);
    if (document.accountId !== value.accountId || document.threadId !== value.threadId) fail();
    return document;
  });
  if (new Set(documents.map((document) => document.id)).size !== documents.length) fail();
  return { accountId: value.accountId, threadId: value.threadId,
    accessEpoch: value.accessEpoch, leaseMs: value.leaseMs as number, documents };
}

/** Ephemeral display cache: caller clears it on logout, context change, and failed refresh. */
export class VisualizationLease {
  private current?: { envelope: VisualizationEnvelope; expiresAt: number };
  clear(): void { this.current = undefined; }
  accept(value: unknown, accountId: string, threadId: string, now: number): void {
    this.clear();
    const envelope = parseEnvelope(value);
    if (envelope.accountId !== accountId || envelope.threadId !== threadId ||
      !Number.isFinite(now)) fail();
    this.current = { envelope, expiresAt: now + envelope.leaseMs };
  }
  get(accountId: string, threadId: string, accessEpoch: string, now: number): VisualizationDocument[] {
    const state = this.current;
    if (!state || state.envelope.accountId !== accountId || state.envelope.threadId !== threadId ||
      state.envelope.accessEpoch !== accessEpoch || !Number.isFinite(now) ||
      now >= state.expiresAt) {
      this.clear();
      return [];
    }
    return state.envelope.documents;
  }
}
