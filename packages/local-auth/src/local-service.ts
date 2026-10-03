import {
  LocalAuth,
  type Identity,
  type ProtectedSessionIO,
  type Transport,
  AuthError,
} from "./index.js";
import {
  authorizeLocally,
  type BrowserOpener,
  type LoopbackListenerFactory,
  type ProtectedSessionStore,
} from "./loopback.js";
import { createOpenAILocalAuth } from "./openai.js";
import {
  parseCatalog,
  buildSubscriptionRequest,
  type Catalog,
} from "./subscription-request.js";

export interface AuthStatus {
  version: 1;
  provider: "openai";
  authMode: "chatgpt_subscription";
  executionHost: "local";
  billing: "subscription";
  phase: "disconnected" | "authorizing" | "connected" | "reauth_required";
  identity?: Identity;
  models: { id: string; name: string }[];
  selectedModelId?: string;
  configurationRevision: number;
  providerEndpoint: "https://api.openai.com/v1/responses";
}
export interface CatalogIntent {
  action: "read_model_catalog";
  endpoint: "https://api.openai.com/v1/models";
  identity: Identity;
}
const slot = (identity: Identity) =>
  JSON.stringify([identity.issuer, identity.subject, identity.clientId]);
function same(a: Identity | undefined, b: Identity | undefined) {
  return (
    a?.issuer === b?.issuer &&
    a?.subject === b?.subject &&
    a?.clientId === b?.clientId
  );
}
export class LocalSessionStore implements ProtectedSessionStore {
  #sessions = new Map<string, LocalAuth>();
  constructor(private readonly io: ProtectedSessionIO) {}
  toJSON() {
    return { type: "protected_local_session_store" };
  }
  async withSession<T>(
    selected: Identity | undefined,
    create: () => LocalAuth,
    action: (session: LocalAuth) => Promise<T>,
  ) {
    let session = selected ? this.#sessions.get(slot(selected)) : undefined;
    if (!session) {
      session = create();
      session.attachProtectedIO(this.io);
      if (selected) await session.restore({ ...selected });
    }
    const result = await action(session);
    const identity = session.identity();
    if (identity) this.#sessions.set(slot(identity), session);
    return result;
  }
  async load(selected: Identity, create: () => LocalAuth) {
    return this.withSession(selected, create, async (session) => session);
  }
}
// This service is an injectable capability, not a route mount. Constructing it
// performs no credential/OS/network operation; every side effect has an explicit
// approval dependency. The host must own one service/store per runtime grant.
export class LocalAuthService {
  #phase: AuthStatus["phase"] = "disconnected";
  #identity?: Identity;
  #catalog?: Catalog;
  #selected?: string;
  #revision = 0;
  #configuration = new AbortController();
  #active?: AbortController;
  #session?: LocalAuth;
  constructor(
    private readonly dependencies: {
      hostId: string;
      transport: Transport;
      listener: LoopbackListenerFactory;
      browser: BrowserOpener;
      store: LocalSessionStore;
      approveCatalog: (
        intent: CatalogIntent,
        signal: AbortSignal,
      ) => Promise<void>;
    },
  ) {}
  toJSON() {
    return { type: "local_auth_service", phase: this.#phase };
  }
  status(): AuthStatus {
    return {
      version: 1,
      provider: "openai",
      authMode: "chatgpt_subscription",
      executionHost: "local",
      billing: "subscription",
      providerEndpoint: "https://api.openai.com/v1/responses",
      phase: this.#phase,
      ...(this.#identity ? { identity: { ...this.#identity } } : {}),
      models:
        this.#catalog?.models.map((model) => ({
          id: model.slug,
          name: model.displayName,
        })) ?? [],
      ...(this.#selected ? { selectedModelId: this.#selected } : {}),
      configurationRevision: this.#revision,
    };
  }
  #create = () =>
    createOpenAILocalAuth(
      this.dependencies.hostId,
      this.dependencies.transport,
    );
  #advanceRevision() {
    this.#configuration.abort();
    this.#configuration = new AbortController();
    this.#revision++;
  }
  #invalidate() {
    this.#catalog = undefined;
    this.#selected = undefined;
    this.#advanceRevision();
  }
  async begin(selected?: Identity, signal?: AbortSignal) {
    if (this.#active) throw new AuthError("invalid_attempt");
    const controller = new AbortController();
    this.#active = controller;
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) controller.abort();
    const previous = this.#identity ? { ...this.#identity } : undefined;
    this.#phase = "authorizing";
    this.#invalidate();
    const attemptRevision = this.#revision;
    let completed: LocalAuth | undefined;
    try {
      // Capture only the opaque session, never a token DTO. The persistent store
      // has already committed a verified bundle before this returns success.
      const capture: ProtectedSessionStore = {
        withSession: (registration, create, action) =>
          this.dependencies.store.withSession(
            registration,
            create,
            async (session) => {
              const value = await action(session);
              completed = session;
              return value;
            },
          ),
      };
      const identity = await authorizeLocally(
        { ...this.dependencies, store: capture },
        selected,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      if (attemptRevision !== this.#revision)
        throw new AuthError("invalid_attempt");
      this.#identity = { ...identity };
      this.#session = completed;
      this.#phase = "connected";
      this.#advanceRevision();
      return this.status();
    } catch {
      if (attemptRevision === this.#revision) {
        this.#identity = previous;
        this.#phase = previous
          ? this.#session?.needsReauthorization()
            ? "reauth_required"
            : "connected"
          : "disconnected";
      }
      throw new AuthError(
        controller.signal.aborted ? "cancelled" : "validation_failed",
      );
    } finally {
      signal?.removeEventListener("abort", cancel);
      if (this.#active === controller) this.#active = undefined;
    }
  }
  cancel() {
    this.#active?.abort();
  }
  async load(identity: Identity) {
    if (this.#active) throw new AuthError("invalid_attempt");
    const controller = new AbortController();
    this.#active = controller;
    this.#invalidate();
    const revision = this.#revision;
    try {
      const session = await this.dependencies.store.load(
        { ...identity },
        this.#create,
      );
      controller.signal.throwIfAborted();
      if (revision !== this.#revision) throw new AuthError("invalid_attempt");
      if (session.needsReauthorization())
        throw new AuthError("reauth_required");
      this.#session = session;
      this.#identity = { ...identity };
      this.#phase = "connected";
      return this.status();
    } catch {
      if (revision === this.#revision) {
        this.#session = undefined;
        this.#identity = undefined;
        this.#phase = "reauth_required";
      }
      throw new AuthError("reauth_required");
    } finally {
      if (this.#active === controller) this.#active = undefined;
    }
  }
  disconnect() {
    this.cancel();
    this.#session = undefined;
    this.#identity = undefined;
    this.#phase = "disconnected";
    this.#invalidate();
    return this.status();
  }
  async refreshCatalog(signal?: AbortSignal) {
    const session = this.#session,
      identity = this.#identity ? { ...this.#identity } : undefined,
      revision = this.#revision;
    if (!session || !identity || this.#phase !== "connected")
      throw new AuthError("reauth_required");
    const bounded = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000);
    try {
      await this.dependencies.approveCatalog(
        {
          action: "read_model_catalog",
          endpoint: "https://api.openai.com/v1/models",
          identity,
        },
        bounded,
      );
      bounded.throwIfAborted();
      const catalog = await session.withAccessToken(async (token, current) => {
        if (!same(current, identity) || revision !== this.#revision)
          throw new AuthError("invalid_attempt");
        const response = await this.dependencies.transport(
          "https://api.openai.com/v1/models",
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/json",
            },
            redirect: "error",
            signal: bounded,
          },
        );
        if (!response.ok || !response.body || response.status >= 300)
          throw new AuthError("validation_failed");
        const reader = response.body.getReader();
        const parts: Uint8Array[] = [];
        let bytes = 0;
        const abort = () => {
          void reader.cancel().catch(() => undefined);
        };
        bounded.addEventListener("abort", abort, { once: true });
        try {
          while (true) {
            const next = await reader.read();
            bounded.throwIfAborted();
            if (next.done) break;
            bytes += next.value.byteLength;
            if (bytes > 131072) throw new AuthError("validation_failed");
            parts.push(next.value);
          }
        } finally {
          bounded.removeEventListener("abort", abort);
          await reader.cancel().catch(() => undefined);
        }
        return parseCatalog(
          JSON.parse(await new Blob(parts as BlobPart[]).text()),
          current,
        );
      }, bounded);
      bounded.throwIfAborted();
      if (revision !== this.#revision || !same(identity, this.#identity))
        throw new AuthError("invalid_attempt");
      this.#catalog = catalog;
      this.#selected = undefined;
      this.#advanceRevision();
      return this.status();
    } catch {
      if (!same(identity, this.#identity) || revision !== this.#revision)
        throw new AuthError("invalid_attempt");
      if (session.needsReauthorization()) {
        this.#phase = "reauth_required";
        this.#invalidate();
      }
      throw new AuthError(
        bounded.aborted
          ? "cancelled"
          : session.needsReauthorization()
            ? "reauth_required"
            : "validation_failed",
      );
    }
  }
  selectModel(modelId: string, expectedRevision: number) {
    if (
      this.#phase !== "connected" ||
      !this.#catalog ||
      expectedRevision !== this.#revision ||
      !this.#catalog.models.some((model) => model.slug === modelId)
    )
      throw new AuthError("invalid_attempt");
    buildSubscriptionRequest({
      catalog: this.#catalog,
      identity: this.#identity!,
      model: modelId,
      instructions: "Morons",
      input: [{ role: "user", content: "catalog validation" }],
    });
    this.#selected = modelId;
    this.#advanceRevision();
    return this.status();
  }
  // Trusted provider adapter obtains these capabilities internally; the HTTP
  // status response must only use status(), never serialize this object.
  providerBinding(expectedRevision: number) {
    if (
      this.#phase !== "connected" ||
      !this.#session ||
      !this.#identity ||
      !this.#catalog ||
      !this.#selected ||
      expectedRevision !== this.#revision
    )
      throw new AuthError("invalid_attempt");
    return {
      session: this.#session,
      identity: { ...this.#identity },
      catalog: this.#catalog,
      selectedModelId: this.#selected,
      configurationRevision: this.#revision,
      signal: this.#configuration.signal,
      isCurrent: () =>
        expectedRevision === this.#revision && this.#phase === "connected",
    };
  }
}
