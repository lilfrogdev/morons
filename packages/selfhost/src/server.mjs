import { createServer } from "node:http";
import { timingSafeEqual, createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { AssistantEntry, createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

// A deterministic fixture provider: this server cannot make paid inference calls.
function fixtureModels() {
  const models = createModels();
  const model = {
    id: "fixture", name: "Offline fixture", provider: "morons-fixture",
    api: "openai-responses", baseUrl: "https://invalid.example",
    reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768, maxTokens: 4096,
  };
  const stream = (_model, conversation) => {
    const events = createAssistantMessageEventStream();
    const last = [...conversation.messages].reverse().find((message) => message.role === "user");
    const input = typeof last?.content === "string" ? last.content : "";
    const answer = {
      role: "assistant", content: [{ type: "text", text: `Fixture: ${input}` }],
      api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), stopReason: "stop",
      usage: {
        input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    queueMicrotask(() => {
      events.push({ type: "start", partial: { ...answer, content: [] } });
      events.push({ type: "done", reason: "stop", message: answer });
    });
    return events;
  };
  models.setProvider({
    id: model.provider, name: "Offline fixture",
    auth: { apiKey: { name: "Fixture", resolve: async () => ({ auth: { apiKey: "fixture" } }) } },
    getModels: () => [model], stream, streamSimple: stream,
  });
  return models;
}

function safeTokenMatch(header, token) {
  const supplied = createHash("sha256").update(header ?? "").digest();
  const expected = createHash("sha256").update(`Bearer ${token}`).digest();
  return timingSafeEqual(supplied, expected);
}

function send(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16384) throw new Error("too_large");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("invalid_json"); }
}

function entryText(entry) {
  return entry.model?.flatMap((message) => {
    if (typeof message.content === "string") return [message.content];
    return message.content?.filter((part) => part.type === "text").map((part) => part.text) ?? [];
  }).join("") ?? "";
}

export async function openFixtureServer({ databasePath, ownerToken, host = "127.0.0.1", port = 0 }) {
  if (!databasePath || typeof databasePath !== "string") throw new Error("databasePath is required");
  if (typeof ownerToken !== "string" || ownerToken.length < 32 || ownerToken.length > 256)
    throw new Error("ownerToken must contain 32-256 characters");
  // Pi Durable's Node adapter has no cross-process lock. One server process must own this file.
  await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
  const harness = await Harness.open(
    await openNodeSqliteStorage(databasePath),
    { models: fixtureModels(), registry: createRegistry(), settings: { compaction: { enabled: false, backgroundTokens: 0 } } },
    BACKGROUND_CONTEXT,
  );
  const root = await harness.root(BACKGROUND_CONTEXT, {
    agent: { model: { provider: "morons-fixture", modelId: "fixture" } },
  });
  harness.resume();
  let shuttingDown = false;
  const server = createServer(async (request, response) => {
    if (shuttingDown) return send(response, 503, { error: "closing" });
    if (!safeTokenMatch(request.headers.authorization, ownerToken))
      return send(response, 401, { error: "unauthorized" });
    const path = new URL(request.url ?? "/", `http://${host}`).pathname;
    try {
      if (request.method === "GET" && path === "/v1/fixture/status")
        return send(response, 200, { ready: true, model: "fixture", durable: true });
      if (request.method === "GET" && path === "/v1/fixture/history") {
        const items = (await root.entries({}, 200, undefined, BACKGROUND_CONTEXT)).items;
        return send(response, 200, {
          messages: items.reverse().filter((entry) => entry.kind === "pi.user" || entry.kind === "pi.assistant")
            .map((entry) => ({ id: entry.id, role: entry.kind === "pi.user" ? "user" : "assistant", text: entryText(entry) })),
        });
      }
      if (request.method === "POST" && path === "/v1/fixture/chat") {
        const body = await readBody(request);
        if (typeof body?.text !== "string" || !body.text.trim() || Buffer.byteLength(body.text) > 8192)
          return send(response, 400, { error: "invalid_text" });
        if (typeof body.requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.requestId))
          return send(response, 400, { error: "invalid_request_id" });
        const submission = await root.submit({ type: "input", content: body.text, requestId: body.requestId }, BACKGROUND_CONTEXT);
        const settled = await submission.wait(BACKGROUND_CONTEXT);
        if (settled.status !== "done" || settled.type !== "input")
          return send(response, 500, { error: "fixture_failed" });
        const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), BACKGROUND_CONTEXT);
        return send(response, 200, { requestId: body.requestId, answer: entryText(answer) });
      }
      return send(response, 404, { error: "not_found" });
    } catch (error) {
      if (error?.message === "too_large") return send(response, 413, { error: "body_too_large" });
      if (error?.message === "invalid_json") return send(response, 400, { error: "invalid_json" });
      return send(response, 500, { error: "internal" });
    }
  });
  try {
    await new Promise((resolve, reject) => server.once("error", reject).listen(port, host, resolve));
  } catch (error) {
    await harness.close(BACKGROUND_CONTEXT);
    throw error;
  }
  return {
    url: `http://${host}:${server.address().port}`,
    async close() {
      shuttingDown = true;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await harness.close(BACKGROUND_CONTEXT);
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { MORONS_FIXTURE_DB: databasePath, MORONS_OWNER_TOKEN: ownerToken } = process.env;
  openFixtureServer({ databasePath, ownerToken, port: Number(process.env.PORT ?? 8787) })
    .then(({ url }) => process.stdout.write(`Fixture server listening at ${url}\n`))
    .catch(() => { process.stderr.write("Fixture server startup failed. Check DB path and owner token.\n"); process.exitCode = 1; });
}
