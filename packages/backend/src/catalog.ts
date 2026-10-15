import {
  VERSION,
  type Handoff,
  type Moron,
  type MoronSession,
} from "../../protocol/index";
import { HttpError, json, readJsonBody } from "./http";

type Sql = DurableObjectState["storage"]["sql"];
const idPattern = /^[a-z][a-z0-9-]{1,39}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, "invalid_request", "Expected a JSON object.");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: string[]) {
  if (Object.keys(value).sort().join(",") !== expected.sort().join(","))
    throw new HttpError(
      400,
      "invalid_request",
      `Expected fields: ${expected.join(", ")}.`,
    );
}
function string(
  value: unknown,
  limit: number,
  label: string,
  pattern?: RegExp,
) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    bytes(value) > limit ||
    (pattern && !pattern.test(value))
  )
    throw new HttpError(400, "invalid_request", `Invalid ${label}.`);
  return value;
}


export class Catalog {
  constructor(private readonly sql: Sql) {
    sql.exec(`CREATE TABLE IF NOT EXISTS named_morons (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, rules TEXT NOT NULL, preferences TEXT NOT NULL,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS moron_sessions (
      id TEXT PRIMARY KEY, moronId TEXT NOT NULL, title TEXT NOT NULL,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS moron_handoffs (
      id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, fromMoronId TEXT NOT NULL,
      toMoronId TEXT NOT NULL, question TEXT NOT NULL, answer TEXT,
      status TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)`);
  }
  private moron(id: string) {
    return this.sql
      .exec<
        Moron & Record<string, SqlStorageValue>
      >("SELECT * FROM named_morons WHERE id = ?", id)
      .toArray()[0];
  }
  private session(id: string) {
    return this.sql
      .exec<
        MoronSession & Record<string, SqlStorageValue>
      >("SELECT * FROM moron_sessions WHERE id = ?", id)
      .toArray()[0];
  }
  private handoff(id: string) {
    return this.sql
      .exec<
        Handoff & Record<string, SqlStorageValue>
      >("SELECT * FROM moron_handoffs WHERE id = ?", id)
      .toArray()[0];
  }
  async handle(request: Request, path: string): Promise<Response> {
    if (
      (request.method === "POST" || request.method === "PUT") &&
      request.headers.get("Content-Type")?.split(";")[0].trim() !==
        "application/json"
    )
      throw new HttpError(415, "content_type", "Expected application/json.");
    if (path === "/v1/morons" && request.method === "GET")
      return json({
        version: VERSION,
        morons: this.sql
          .exec<
            Moron & Record<string, SqlStorageValue>
          >("SELECT * FROM named_morons ORDER BY createdAt, id")
          .toArray(),
      });
    if (path === "/v1/morons" && request.method === "POST") {
      const body = object(await readJsonBody(request));
      keys(body, ["id", "name", "rules", "preferences"]);
      const id = string(body.id, 40, "moron ID", idPattern);
      const name = string(body.name, 80, "name");
      const rules = string(body.rules, 8192, "rules");
      const preferences = string(body.preferences, 8192, "preferences");
      if (this.moron(id))
        throw new HttpError(409, "already_exists", "Moron ID already exists.");
      if (this.sql.exec("SELECT id FROM named_morons").toArray().length >= 32)
        throw new HttpError(429, "moron_limit", "Named moron limit reached.");
      const now = Date.now();
      this.sql.exec(
        "INSERT INTO named_morons VALUES(?,?,?,?,?,?)",
        id,
        name,
        rules,
        preferences,
        now,
        now,
      );
      return json({ version: VERSION, moron: this.moron(id) }, 201);
    }
    const moronPath = /^\/v1\/morons\/([a-z][a-z0-9-]{1,39})$/.exec(path);
    if (moronPath && request.method === "GET") {
      const moron = this.moron(moronPath[1]);
      if (!moron) throw new HttpError(404, "not_found", "Moron not found.");
      return json({ version: VERSION, moron });
    }
    if (moronPath && request.method === "PUT") {
      if (!this.moron(moronPath[1]))
        throw new HttpError(404, "not_found", "Moron not found.");
      const body = object(await readJsonBody(request));
      keys(body, ["name", "rules", "preferences"]);
      const name = string(body.name, 80, "name");
      const rules = string(body.rules, 8192, "rules");
      const preferences = string(body.preferences, 8192, "preferences");
      this.sql.exec(
        "UPDATE named_morons SET name=?,rules=?,preferences=?,updatedAt=? WHERE id=?",
        name,
        rules,
        preferences,
        Date.now(),
        moronPath[1],
      );
      return json({ version: VERSION, moron: this.moron(moronPath[1]) });
    }
    if (path === "/v1/sessions" && request.method === "GET")
      return json({
        version: VERSION,
        sessions: this.sql
          .exec<
            MoronSession & Record<string, SqlStorageValue>
          >("SELECT * FROM moron_sessions ORDER BY createdAt, id")
          .toArray(),
      });
    if (path === "/v1/sessions" && request.method === "POST") {
      const body = object(await readJsonBody(request));
      keys(body, ["id", "moronId", "title"]);
      const id = string(body.id, 36, "session ID", uuidPattern);
      const moronId = string(body.moronId, 40, "moron ID", idPattern);
      const title = string(body.title, 120, "session title");
      if (!this.moron(moronId))
        throw new HttpError(404, "not_found", "Moron not found.");
      const existing = this.session(id);
      if (existing) {
        if (existing.moronId !== moronId || existing.title !== title)
          throw new HttpError(
            409,
            "request_conflict",
            "Session ID already belongs to different input.",
          );
        return json({ version: VERSION, session: existing });
      }
      if (
        this.sql.exec("SELECT id FROM moron_sessions").toArray().length >= 200
      )
        throw new HttpError(429, "session_limit", "Session limit reached.");
      const now = Date.now();
      this.sql.exec(
        "INSERT INTO moron_sessions VALUES(?,?,?,?,?)",
        id,
        moronId,
        title,
        now,
        now,
      );
      return json({ version: VERSION, session: this.session(id) }, 201);
    }
    const sessionPath = /^\/v1\/sessions\/([0-9a-f-]{36})$/.exec(path);
    if (sessionPath && request.method === "GET") {
      const session = this.session(sessionPath[1]);
      if (!session) throw new HttpError(404, "not_found", "Session not found.");
      return json({ version: VERSION, session });
    }
    if (path === "/v1/handoffs" && request.method === "GET")
      return json({
        version: VERSION,
        handoffs: this.sql
          .exec<
            Handoff & Record<string, SqlStorageValue>
          >("SELECT * FROM moron_handoffs ORDER BY createdAt, id")
          .toArray(),
      });
    if (path === "/v1/handoffs" && request.method === "POST") {
      const body = object(await readJsonBody(request));
      keys(body, ["id", "sessionId", "toMoronId", "question"]);
      const id = string(body.id, 36, "handoff ID", uuidPattern);
      const sessionId = string(body.sessionId, 36, "session ID", uuidPattern);
      const toMoronId = string(body.toMoronId, 40, "recipient ID", idPattern);
      const question = string(body.question, 4096, "question");
      const session = this.session(sessionId);
      if (!session) throw new HttpError(404, "not_found", "Session not found.");
      if (!this.moron(toMoronId))
        throw new HttpError(404, "not_found", "Recipient not found.");
      if (session.moronId === toMoronId)
        throw new HttpError(
          400,
          "invalid_request",
          "A moron cannot hand off to itself.",
        );
      const existing = this.handoff(id);
      if (existing) {
        if (
          existing.sessionId !== sessionId ||
          existing.toMoronId !== toMoronId ||
          existing.question !== question
        )
          throw new HttpError(
            409,
            "request_conflict",
            "Handoff ID already belongs to different input.",
          );
        return json({ version: VERSION, handoff: existing });
      }
      if (
        this.sql.exec("SELECT id FROM moron_handoffs").toArray().length >= 500
      )
        throw new HttpError(429, "handoff_limit", "Handoff limit reached.");
      const now = Date.now();
      this.sql.exec(
        "INSERT INTO moron_handoffs VALUES(?,?,?,?,?,NULL,'pending',?,?)",
        id,
        sessionId,
        session.moronId,
        toMoronId,
        question,
        now,
        now,
      );
      return json({ version: VERSION, handoff: this.handoff(id) }, 201);
    }
    const handoffPath = /^\/v1\/handoffs\/([0-9a-f-]{36})(\/answer)?$/.exec(
      path,
    );
    if (handoffPath && request.method === "GET" && !handoffPath[2]) {
      const handoff = this.handoff(handoffPath[1]);
      if (!handoff) throw new HttpError(404, "not_found", "Handoff not found.");
      return json({ version: VERSION, handoff });
    }
    if (handoffPath && request.method === "POST" && handoffPath[2]) {
      const handoff = this.handoff(handoffPath[1]);
      if (!handoff) throw new HttpError(404, "not_found", "Handoff not found.");
      const body = object(await readJsonBody(request));
      keys(body, ["answer"]);
      const answer = string(body.answer, 8192, "answer");
      if (handoff.answer !== null && handoff.answer !== answer)
        throw new HttpError(
          409,
          "request_conflict",
          "Handoff already has a different answer.",
        );
      if (handoff.answer === null)
        this.sql.exec(
          "UPDATE moron_handoffs SET answer=?,status='answered',updatedAt=? WHERE id=?",
          answer,
          Date.now(),
          handoff.id,
        );
      return json({ version: VERSION, handoff: this.handoff(handoff.id) });
    }
    throw new HttpError(404, "not_found", "Unknown endpoint.");
  }
}
