import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Catalog } from "../src/catalog";
import { HttpError } from "../src/http";

// Exercise the same SQL and HTTP validation without Miniflare's local socket.
it("persists owner catalog records and scoped handoffs with idempotent IDs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "morons-catalog-sqlite-"));
  const file = join(dir, "catalog.sqlite");
  const db = new DatabaseSync(file);
  // Writes execute eagerly in Cloudflare's SQL API, so adapt Node SQLite likewise.
  const eagerSql = {
    exec(query: string, ...values: unknown[]) {
      const statement = db.prepare(query);
      const rows = statement.columns().length
        ? statement.all(...(values as []))
        : (statement.run(...(values as [])), []);
      return { toArray: () => rows };
    },
  };
  const catalog = new Catalog(eagerSql as never);
  const call = async (path: string, method = "GET", body?: unknown) => {
    try {
      return await catalog.handle(
        new Request(`http://localhost${path}`, {
          method,
          headers: { "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        path,
      );
    } catch (error) {
      if (error instanceof HttpError)
        return new Response(null, { status: error.status });
      throw error;
    }
  };
  expect(
    (
      await call("/v1/morons", "POST", {
        id: "repo",
        name: "Repo",
        rules: "Read source.",
        preferences: "Concise.",
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await call("/v1/morons", "POST", {
        id: "freddy",
        name: "Freddy",
        rules: "Budget answers.",
        preferences: "USD.",
      })
    ).status,
  ).toBe(201);
  const sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const handoffId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  expect(
    (
      await call("/v1/sessions", "POST", {
        id: sessionId,
        moronId: "repo",
        title: "Repo work",
      })
    ).status,
  ).toBe(201);
  const question = {
    id: handoffId,
    sessionId,
    toMoronId: "freddy",
    question: "Budget?",
  };
  const created = await call("/v1/handoffs", "POST", question);
  expect(created.status).toBe(201);
  expect(((await created.json()) as any).handoff.fromMoronId).toBe("repo");
  expect((await call("/v1/handoffs", "POST", question)).status).toBe(200);
  expect(
    (
      await call(`/v1/handoffs/${handoffId}/answer`, "POST", {
        answer: "USD 200.",
      })
    ).status,
  ).toBe(200);
  const saved = (await (await call(`/v1/handoffs/${handoffId}`)).json()) as any;
  expect(saved.handoff.answer).toBe("USD 200.");
  expect(saved.handoff).not.toHaveProperty("transcript");
  expect(
    (
      await call(`/v1/handoffs/${handoffId}/answer`, "POST", {
        answer: "Other",
      })
    ).status,
  ).toBe(409);
  db.close();
  const reopened = new DatabaseSync(file);
  expect(
    reopened
      .prepare("SELECT answer FROM moron_handoffs WHERE id=?")
      .get(handoffId)?.answer,
  ).toBe("USD 200.");
  expect(
    reopened.prepare("SELECT COUNT(*) AS count FROM moron_sessions").get()
      ?.count,
  ).toBe(1);
  reopened.close();
  await rm(dir, { recursive: true, force: true });
});
