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
export type VisualizationDraft = ChartDraft | TableDraft;

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
