import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { ApprovalStore } from "../approvals/store";
export function safeTools(
  store: ApprovalStore,
  activeTask: () => string | undefined,
) {
  return [
    defineTool({
      name: "get_current_time",
      description:
        "Read the current UTC time from the server clock. No external access.",
      parameters: Type.Object({}, { additionalProperties: false }),
      replay: "safe",
      execute: async (_args, api, context) => {
        const value = await api.memo(
          "utc-time",
          new Date().toISOString(),
          context,
        );
        return { content: [{ type: "text" as const, text: String(value) }] };
      },
    }),
    defineTool({
      name: "request_user_confirmation",
      description:
        "Ask the owner to explicitly approve or deny a short message. This only confirms this message; it performs no action and grants no permission to other tools or future actions.",
      parameters: Type.Object(
        { message: Type.String({ minLength: 1, maxLength: 512 }) },
        { additionalProperties: false },
      ),
      replay: "safe",
      executionMode: "sequential",
      execute: async (args, api, context) => {
        const taskId = activeTask();
        if (!taskId) throw new Error("Task stopped");
        const record = await store.request(
          taskId,
          `${api.taskId}:${api.callId}`,
          "request_user_confirmation",
          args,
        );
        const settled = await store.wait(record.id, context.abortSignal);
        // Confirmation has no side effect; a recovered consumed result is safe to report again.
        const approved =
          settled.state === "consumed" || store.consume(record.id, record);
        return {
          content: [
            {
              type: "text" as const,
              text: `Confirmation ${approved ? "approved" : settled.state}. No external action was performed.`,
            },
          ],
        };
      },
    }),
  ];
}
