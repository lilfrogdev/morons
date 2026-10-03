import { expect, it } from "vitest";
import { productionModels } from "../src/model";
it("caps real provider payloads and disables provider retries with a mock HTTP transport", async () => {
  const models = productionModels("sk-fixture-server-key");
  const model = models.getModel("openai", "gpt-5-mini")!;
  const requests: { body: any; auth: string | null; url: string }[] = [];
  const stream = models.streamSimple(
    model,
    { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
    {
      maxTokens: 90000,
      maxRetries: 5,
      transport: "sse",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push({
          body: await request.json(),
          auth: request.headers.get("Authorization"),
          url: request.url,
        });
        return Response.json(
          {
            error: {
              message: "Mock provider unavailable",
              type: "server_error",
            },
          },
          { status: 503 },
        );
      },
    },
  );
  const result = await stream.result();
  expect(result.stopReason).toBe("error");
  expect(requests).toHaveLength(1);
  expect(requests[0].body.max_output_tokens).toBe(4096);
  expect(requests[0].body.tools ?? []).toEqual([]);
  expect(requests[0].auth).toBe("Bearer sk-fixture-server-key");
  expect(requests[0].url).toBe("https://api.openai.com/v1/responses");
});
