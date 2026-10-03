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
export function terminal(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "stopped";
}
