import { createModels, type Provider } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
const model: Model<"openai-responses"> = {
  id: "mock",
  name: "Local deterministic mock",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://invalid.example",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32768,
  maxTokens: 4096,
};
export function mockModels() {
  const models = createModels();
  const stream: Provider["streamSimple"] = (_model, context, options) => {
    const events = createAssistantMessageEventStream();
    const last = [...context.messages]
      .reverse()
      .find((message) => message.role === "user");
    const input = typeof last?.content === "string" ? last.content : "";
    const answer: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      timestamp: Date.now(),
      stopReason: "stop",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    void (async () => {
      events.push({ type: "start", partial: answer });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(
          resolve,
          input.startsWith("slow:") ? 3000 : 100,
        );
        options?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
      if (options?.signal?.aborted) {
        answer.stopReason = "aborted";
        events.push({ type: "error", reason: "aborted", error: answer });
      } else if (input === "fail") {
        answer.stopReason = "error";
        answer.errorMessage = "Mock failure";
        events.push({ type: "error", reason: "error", error: answer });
      } else {
        answer.content = [{ type: "text", text: `Mock: ${input}` }];
        events.push({ type: "done", reason: "stop", message: answer });
      }
    })();
    return events;
  };
  models.setProvider({
    id: "openai",
    name: "Local mock",
    auth: {
      apiKey: {
        name: "Mock",
        resolve: async () => ({ auth: { apiKey: "mock" } }),
      },
    },
    getModels: () => [model],
    stream: stream as Provider["stream"],
    streamSimple: stream,
  });
  return models;
}
