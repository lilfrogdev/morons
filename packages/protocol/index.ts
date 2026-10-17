export const VERSION = 1 as const;
export const LIMITS = {
  maxInputBytes: 8192,
  maxTasks: 200,
  maxHistoryBytes: 524288,
  maxOutputTokens: 4096,
} as const;
export type TaskStatus =
  | "accepted"
  | "running"
  | "completed"
  | "failed"
  | "stopped";
export interface Task {
  id: string;
  status: TaskStatus;
  input: string;
  createdAt: number;
  updatedAt: number;
  error: string | null;
}
export interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  taskId: string;
  partial: boolean;
}
export interface Snapshot {
  version: typeof VERSION;
  rootId: "root";
  tasks: Task[];
  messages: Message[];
  activeTaskId: string | null;
}
export interface Submit {
  requestId: string;
  text: string;
}
export interface TaskResponse {
  version: typeof VERSION;
  task: Task;
}
export interface Status {
  version: typeof VERSION;
  ready: boolean;
  model: string;
  authMode: "bearer";
  limits: typeof LIMITS;
}
export interface Failure {
  version: typeof VERSION;
  error: { code: string; message: string };
}


export interface Moron {
  id: string;
  name: string;
  rules: string;
  preferences: string;
  createdAt: number;
  updatedAt: number;
}
export interface MoronSession {
  id: string;
  moronId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}
export interface Handoff {
  id: string;
  sessionId: string;
  fromMoronId: string;
  toMoronId: string;
  question: string;
  answer: string | null;
  status: "pending" | "answered";
  createdAt: number;
  updatedAt: number;
}
export function terminal(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "stopped";
}


export interface GeneratedImage {
  id: string;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  moronId: string;
  title: string;
  status: "generating" | "completed" | "failed" | "uncertain";
  model: string;
  createdAt: number;
  width: number | null;
  height: number | null;
  byteLength: number;
  mimeType: "image/png";
  error: string | null;
  usage: unknown;
  costKnown: false;
}

export interface ImageProviderStatus {
  configured: boolean;
  provider: "openai-images";
  model: string;
  authentication: "separate_server_api_key";
  subscriptionSupported: false;
  message: string;
}

export type PermissionMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";
export interface PermissionAction {
  id: string;
  sessionId: string;
  workspaceId: string;
  repositoryId: string | null;
  kind: "read" | "edit" | "command" | "source-apply" | "external-request";
  action: Record<string, unknown>;
  proposalId: string | null;
  baseRevision: string | null;
  fingerprint: string;
  mode: PermissionMode;
  revision: number;
  status: "pending" | "ready" | "active" | "complete" | "rejected" | "revoked";
  reason: string | null;
  createdAt: number;
  expiresAt: number;
}
export interface SessionPermissions {
  sessionId: string;
  workspaceId: string;
  repositoryId: string | null;
  mode: PermissionMode;
  effectiveMode: PermissionMode;
  revision: number;
  autoReviewSupported: false;
  pending: PermissionAction[];
}
export interface ReviewApplication {
  reviewId: string;
  status: string;
  error: string | null;
  updatedAt: number;
}
