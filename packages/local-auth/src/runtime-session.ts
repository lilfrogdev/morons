import type { Identity } from "./index";

// This boundary carries protected, already verified material. It is not a token
// import endpoint: signature/grant validation and exact transfer approval belong
// to a future trusted adapter. No runtime storage or network adapter is supplied.
export interface Registration<Material> {
  identity: Identity;
  material: Material;
  expiresAt: number;
  refreshExpiresAt: number;
  earliestRefreshAt: number;
}
export interface RuntimeState<Material> {
  hostId: string;
  revision: number;
  registration?: Registration<Material>;
  phase: "empty" | "ready" | "refreshing" | "reauth_required";
  intent?: { id: string; expiresAt: number };
}
export interface ProtectedRepository<Material> {
  // Serialize across ALL owners, give a detached draft, and atomically persist
  // only if the synchronous callback succeeds. Throw on uncertain persistence.
  // A real adapter must protect material at rest and never log draft contents.
  transaction<T>(work: (draft: RuntimeState<Material>) => T): Promise<T>;
}
export type Rotation<Material> = (
  previous: Registration<Material>,
  signal: AbortSignal,
) => Promise<Registration<Material>>;
export interface SessionStatus {
  phase: RuntimeState<unknown>["phase"];
  revision: number;
}
export class SessionError extends Error {
  constructor(
    readonly code: "busy" | "cancelled" | "reauth_required" | "storage_failed",
  ) {
    super(`Runtime session ${code.replaceAll("_", " ")}.`);
    this.name = "SessionError";
  }
}
const HOST =
  /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function sameIdentity(a: Identity, b: Identity) {
  return (
    a.issuer === b.issuer &&
    a.subject === b.subject &&
    a.clientId === b.clientId
  );
}
function valid<Material>(record: Registration<Material>, now: number) {
  const { identity } = record;
  return (
    identity.issuer === "https://auth.openai.com" &&
    /^[^\x00-\x20\x7f]{1,16384}$/.test(identity.subject) &&
    /^[A-Za-z0-9_-]{1,256}$/.test(identity.clientId) &&
    identity.clientId !== "dynamic_agent_client" &&
    Number.isFinite(record.expiresAt) &&
    record.expiresAt > now &&
    record.expiresAt <= now + 86400000 &&
    Number.isFinite(record.refreshExpiresAt) &&
    record.refreshExpiresAt > now &&
    record.refreshExpiresAt <= now + 30 * 86400000 &&
    Number.isFinite(record.earliestRefreshAt) &&
    record.earliestRefreshAt <= record.expiresAt
  );
}

// Runtime-independent ownership/commit protocol only. The trusted rotation
// capability must validate the entire replacement grant and require a new
// refresh token before returning. OAuth endpoints and JWT logic are not here.
export class RuntimeSession<Material> {
  #blocked = false;
  #repository: ProtectedRepository<Material>;
  #rotate: Rotation<Material>;
  constructor(
    repository: ProtectedRepository<Material>,
    rotate: Rotation<Material>,
  ) {
    this.#repository = repository;
    this.#rotate = rotate;
  }
  toJSON() {
    return { type: "runtime_session" };
  }

  async status(): Promise<SessionStatus> {
    try {
      return await this.#repository.transaction((state) => {
        this.#assertState(state);
        return {
          phase: this.#blocked ? "reauth_required" : state.phase,
          revision: state.revision,
        };
      });
    } catch {
      throw new SessionError("storage_failed");
    }
  }
  #assertState(state: RuntimeState<Material>) {
    if (
      !HOST.test(state.hostId) ||
      !Number.isSafeInteger(state.revision) ||
      state.revision < 0 ||
      !["empty", "ready", "refreshing", "reauth_required"].includes(state.phase)
    )
      throw new SessionError("storage_failed");
  }

  // Call after startup or before a task. Never retry an expired refresh intent:
  // a previous owner may have received and lost a rotated replacement token.
  async recover(): Promise<SessionStatus> {
    try {
      return await this.#repository.transaction((state) => {
        this.#assertState(state);
        if (state.phase === "refreshing") {
          if (!state.intent || state.intent.expiresAt <= Date.now()) {
            state.phase = "reauth_required";
            delete state.intent;
            state.revision++;
          }
        }
        return {
          phase: this.#blocked ? "reauth_required" : state.phase,
          revision: state.revision,
        };
      });
    } catch {
      throw new SessionError("storage_failed");
    }
  }

  async refresh(signal?: AbortSignal): Promise<SessionStatus> {
    if (signal?.aborted) throw new SessionError("cancelled");
    if (this.#blocked) throw new SessionError("reauth_required");
    const id = crypto.randomUUID();
    const bounded = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000);
    let claim:
      | {
          previous: Registration<Material>;
          revision: number;
          hostId: string;
          identity: Identity;
        }
      | undefined;
    try {
      claim = await this.#repository.transaction((state) => {
        this.#assertState(state);
        bounded.throwIfAborted();
        if (state.phase === "refreshing") throw new SessionError("busy");
        const record = state.registration;
        if (
          state.phase !== "ready" ||
          !record ||
          record.refreshExpiresAt <= Date.now()
        )
          throw new SessionError("reauth_required");
        if (
          record.expiresAt > Date.now() + 180000 ||
          record.earliestRefreshAt > Date.now()
        )
          return undefined;
        // Commit intent BEFORE any network-capable callback gets the grant.
        state.phase = "refreshing";
        state.intent = { id, expiresAt: Date.now() + 60000 };
        state.revision++;
        return {
          previous: record,
          revision: state.revision,
          hostId: state.hostId,
          identity: { ...record.identity },
        };
      });
    } catch (error) {
      if (error instanceof SessionError) throw error;
      if (bounded.aborted) throw new SessionError("cancelled");
      // Persistence may have succeeded despite an error; never dispatch.
      this.#blocked = true;
      throw new SessionError("storage_failed");
    }
    if (!claim) return this.status();
    try {
      bounded.throwIfAborted();
      const replacement = await this.#rotate(claim.previous, bounded);
      bounded.throwIfAborted();
      if (
        !valid(replacement, Date.now()) ||
        !sameIdentity(claim.identity, replacement.identity)
      )
        throw new SessionError("reauth_required");
      return await this.#repository.transaction((state) => {
        this.#assertState(state);
        bounded.throwIfAborted();
        if (
          state.phase !== "refreshing" ||
          state.intent?.id !== id ||
          state.intent.expiresAt <= Date.now() ||
          state.revision !== claim!.revision ||
          state.hostId !== claim!.hostId
        )
          throw new SessionError("reauth_required");
        state.registration = replacement;
        state.phase = "ready";
        delete state.intent;
        state.revision++;
        return { phase: state.phase, revision: state.revision };
      });
    } catch {
      this.#blocked = true;
      try {
        await this.#repository.transaction((state) => {
          if (state.phase === "refreshing" && state.intent?.id === id) {
            state.phase = "reauth_required";
            delete state.intent;
            state.revision++;
          }
        });
      } catch {
        /* Retained durable intent blocks another owner until recovery. */
      }
      throw new SessionError(bounded.aborted ? "cancelled" : "reauth_required");
    }
  }
}
