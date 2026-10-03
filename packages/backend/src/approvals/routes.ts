import type { ApprovalDecision } from "../../../protocol/approvals";
import { VERSION } from "../../../protocol/index";
import { HttpError, json, readJsonBody } from "../http";
import type { ApprovalStore } from "./store";
// Caller must authenticate with the existing single-owner bearer before invoking.
export async function approvalRoute(
  request: Request,
  store: ApprovalStore,
): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (request.method === "GET" && path === "/v1/root/approvals")
    return json({ version: VERSION, approvals: store.list() });
  const match = /^\/v1\/root\/approvals\/([0-9a-f-]{36})\/decision$/.exec(path);
  if (request.method !== "POST" || !match) return;
  const body = await readJsonBody(request);
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).sort().join(",") !== "decision,digest,taskId"
  )
    throw new HttpError(
      400,
      "invalid_decision",
      "Exact approval decision fields required.",
    );
  const decision = body as ApprovalDecision;
  if (
    typeof decision.taskId !== "string" ||
    typeof decision.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(decision.digest) ||
    !["approve", "deny"].includes(decision.decision)
  )
    throw new HttpError(400, "invalid_decision", "Invalid approval decision.");
  return json({ version: VERSION, approval: store.decide(match[1], decision) });
}
