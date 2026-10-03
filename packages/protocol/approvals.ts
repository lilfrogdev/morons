export type ApprovalState =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "cancelled"
  | "consumed";
export interface Approval {
  id: string;
  taskId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  digest: string;
  state: ApprovalState;
  createdAt: number;
  expiresAt: number;
}
export interface ApprovalDecision {
  taskId: string;
  digest: string;
  decision: "approve" | "deny";
}
