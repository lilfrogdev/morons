import {
  createAssistantMessageEventStream,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai/utils/event-stream";
// Pi persists provider messages before the root DTO layer. Sanitize at this
// boundary, and detach partial message metadata from Pi's shared mutable object.
export function privateErrors(
  source: AssistantMessageEventStream,
  status: () => number | undefined,
  identity: { api: string; provider: string; id: string },
) {
  const errorMessage = () => {
    const code = status();
    return code !== undefined && code >= 400 && code <= 599
      ? `Provider request failed (HTTP ${code}).`
      : "Provider request failed.";
  };
  const output = createAssistantMessageEventStream();
  void (async () => {
    try {
      for await (const event of source) {
        if (event.type === "error") {
          event.error.errorMessage =
            event.reason === "aborted"
              ? "Provider request cancelled."
              : errorMessage();
          output.push({
            ...event,
            error: {
              role: "assistant",
              content: [],
              api: identity.api,
              provider: identity.provider,
              model: identity.id,
              usage: event.error.usage,
              stopReason: event.reason,
              timestamp: Date.now(),
              errorMessage: event.error.errorMessage,
            },
          });
        } else if ("partial" in event) {
          output.push({
            ...event,
            partial: {
              ...event.partial,
              errorMessage: undefined,
              rawStopReason: undefined,
              diagnostics: undefined,
            },
          });
        } else if (event.type === "done") {
          output.push({
            ...event,
            message: { ...event.message, errorMessage: undefined },
          });
        } else output.push(event);
      }
    } catch {
      output.push({
        type: "error",
        reason: "error",
        error: {
          role: "assistant",
          content: [],
          api: identity.api,
          provider: identity.provider,
          model: identity.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "error",
          timestamp: Date.now(),
          errorMessage: errorMessage(),
        },
      });
    } finally {
      output.end();
    }
  })();
  return output;
}
