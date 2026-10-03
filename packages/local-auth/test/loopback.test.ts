import { beforeAll, expect, it, vi } from "vitest";
import { LocalAuth, type Identity, type Transport } from "../src/index";
import { createOpenAILocalAuth } from "../src/openai";
import {
  authorizeLocally,
  LOOPBACK_LIMITS,
  type BoundListener,
  type CallbackRequest,
  type ProtectedSessionStore,
} from "../src/loopback";
const hostId = "urn:uuid:11111111-1111-4111-8111-111111111111";
const secret = "synthetic-loopback-secret-never-live";
const issuer = "https://auth.openai.com";
let keys: CryptoKeyPair;
let jwk: JsonWebKey & { kid: string; alg: string; use: string };
beforeAll(async () => {
  keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  jwk = {
    ...(await crypto.subtle.exportKey("jwk", keys.publicKey)),
    kid: "fixture",
    alg: "RS256",
    use: "sig",
  };
});
const b64 = (value: string | Uint8Array) =>
  Buffer.from(value).toString("base64url");
function fixture() {
  let session: LocalAuth | undefined;
  let pending: ((value: IteratorResult<CallbackRequest>) => void) | undefined;
  let closed = false;
  let closes = 0;
  let opens = 0;
  let listenOptions: unknown;
  let authorization: URL;
  const queued: CallbackRequest[] = [];
  const responses: { status: number; html: string }[] = [];
  const requests: { url: string; body?: URLSearchParams }[] = [];
  let onOpen: (() => void | Promise<void>) | undefined;
  let tokenError = false;
  const listener: BoundListener = {
    host: "127.0.0.1",
    port: 24680,
    requests: {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            if (queued.length) return { done: false, value: queued.shift()! };
            if (closed) return { done: true, value: undefined };
            return new Promise<IteratorResult<CallbackRequest>>((resolve) => {
              pending = resolve;
            });
          },
        };
      },
    },
    close: async () => {
      closes++;
      closed = true;
      pending?.({ done: true, value: undefined });
      pending = undefined;
    },
  };
  const push = (request: CallbackRequest) => {
    if (closed) return;
    if (pending) {
      const next = pending;
      pending = undefined;
      next({ done: false, value: request });
    } else queued.push(request);
  };
  const request = (change: Partial<CallbackRequest> = {}) => {
    const target = `/auth/callback?code=synthetic-code&state=${authorization.searchParams.get("state")}&client_id=oaiapp_fixture`;
    return {
      method: "GET",
      target,
      host: "127.0.0.1:24680",
      headerBytes: 100,
      bodyBytes: 0,
      respond: async (status: number, html: string) => {
        responses.push({ status, html });
      },
      ...change,
    };
  };
  const transport: Transport = async (url, init) => {
    requests.push({
      url,
      body:
        init.body instanceof URLSearchParams
          ? new URLSearchParams(init.body)
          : undefined,
    });
    if (url === `${issuer}/.well-known/jwks.json`)
      return Response.json({ keys: [jwk] });
    if (tokenError)
      return Response.json(
        { error: "invalid_grant", error_description: secret },
        { status: 400 },
      );
    const now = Math.floor(Date.now() / 1000);
    const header = b64(JSON.stringify({ alg: "RS256", kid: "fixture" }));
    const body = b64(
      JSON.stringify({
        iss: issuer,
        aud: "oaiapp_fixture",
        sub: "fixture-account",
        iat: now,
        exp: now + 3600,
        nonce: authorization.searchParams.get("nonce"),
      }),
    );
    const message = `${header}.${body}`;
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keys.privateKey,
      new TextEncoder().encode(message),
    );
    return Response.json({
      access_token: secret,
      refresh_token: `${secret}-refresh`,
      id_token: `${message}.${b64(new Uint8Array(signature))}`,
      scope: "openid offline_access chatgpt.tokens.use.direct",
      expires_in: 3600,
      token_type: "Bearer",
    });
  };
  const store: ProtectedSessionStore = {
    withSession: async (_selected, create, action) => {
      session ??= create();
      return action(session);
    },
  };
  const dependencies = {
    hostId,
    transport,
    store,
    listener: {
      listen: async (options: unknown) => {
        listenOptions = options;
        return listener;
      },
    },
    browser: {
      open: async (url: string) => {
        opens++;
        authorization = new URL(url);
        if (onOpen) await onOpen();
        else push(request());
      },
    },
  };
  return {
    dependencies,
    listener,
    push,
    request,
    responses,
    requests,
    authorization: () => authorization,
    setAuthorization: (url: URL) => {
      authorization = url;
    },
    session: () => session,
    counts: () => ({ closes, opens }),
    options: () => listenOptions,
    onOpen: (action: () => void | Promise<void>) => {
      onOpen = action;
    },
    tokenError: () => {
      tokenError = true;
    },
  };
}
it("pins official trust metadata and library signature checks with a synthetic transport", async () => {
  const f = fixture();
  const auth = createOpenAILocalAuth(hostId, f.dependencies.transport);
  const pending = await auth.begin("http://127.0.0.1:24680/auth/callback");
  expect(new URL(pending.url).origin + new URL(pending.url).pathname).toBe(
    `${issuer}/api/accounts/authorize`,
  );
  expect(f.requests).toHaveLength(0);
  const identity = await authorizeLocally({
    ...f.dependencies,
    issuer: "https://substitution.fixture.invalid",
  } as typeof f.dependencies);
  expect(identity).toEqual({
    issuer,
    subject: "fixture-account",
    clientId: "oaiapp_fixture",
  });
  expect(f.requests.map((r) => r.url)).toEqual([
    `${issuer}/api/accounts/oauth/token`,
    `${issuer}/.well-known/jwks.json`,
  ]);
  expect(f.requests[0].body!.get("redirect_uri")).toBe(
    "http://127.0.0.1:24680/auth/callback",
  );
  expect(f.options()).toEqual({
    host: "127.0.0.1",
    port: 0,
    maxHeaderBytes: 8192,
    maxPendingRequests: 1,
  });
  expect(f.counts()).toEqual({ closes: 1, opens: 1 });
  expect(f.responses[0].status).toBe(200);
  expect(JSON.stringify(f.responses)).not.toContain(secret);
  expect(JSON.stringify(f.responses)).not.toContain("synthetic-code");
});
it("rejects substituted callback paths/hosts, wrong state, duplicate fields and oversize then accepts exact callback", async () => {
  const f = fixture();
  f.onOpen(() => {
    const valid = f.request();
    for (const change of [
      { target: "/wrong?state=wrong" },
      {
        target: valid.target.replace(
          "/auth/callback",
          "/other/../auth/callback",
        ),
      },
      { host: "localhost:24680" },
      { host: "127.0.0.1:24681" },
      { target: "https://substitution.fixture.invalid/auth/callback" },
      { target: valid.target.replace(/state=[^&]+/, "state=wrong") },
      { target: `${valid.target}&state=duplicate` },
      { target: `${valid.target}&padding=${"x".repeat(8192)}` },
      { headerBytes: 8193 },
      { method: "POST" },
      { bodyBytes: 1 },
    ])
      f.push(f.request(change));
    f.push(valid);
  });
  await expect(authorizeLocally(f.dependencies)).resolves.toMatchObject({
    subject: "fixture-account",
  });
  expect(f.requests.filter((r) => r.url.endsWith("/token"))).toHaveLength(1);
  expect(f.responses.slice(0, -1).every((r) => r.status >= 400)).toBe(true);
  expect(f.responses.at(-1)!.status).toBe(200);
  expect(f.counts().closes).toBe(1);
});
it("handles returning registration without new client/name and rejects selected-account substitution", async () => {
  const f = fixture();
  const identity = await authorizeLocally(f.dependencies);
  // Replace the closed fixture listener with a fresh in-memory stream.
  const g = fixture();
  g.dependencies.store = {
    withSession: async (_selected, _create, action) => action(f.session()!),
  };
  g.onOpen(() => {
    f.setAuthorization(g.authorization());
    const request = g.request();
    request.target = request.target.replace("&client_id=oaiapp_fixture", "");
    g.push(request);
  });
  await expect(authorizeLocally(g.dependencies, identity)).resolves.toEqual(
    identity,
  );
  expect(g.authorization().searchParams.get("client_id")).toBe(
    "oaiapp_fixture",
  );
  expect(g.authorization().searchParams.has("agent_name_hint")).toBe(false);
  const h = fixture();
  h.dependencies.store = {
    withSession: async (_selected, _create, action) => action(f.session()!),
  };
  await expect(
    authorizeLocally(h.dependencies, {
      ...identity,
      clientId: "other-workspace",
    }),
  ).rejects.toMatchObject({ code: "authorization_failed" });
  expect(h.counts()).toEqual({ closes: 0, opens: 0 });
});
it("accepts one terminal callback and closes before replay can exchange another code", async () => {
  const f = fixture();
  f.onOpen(() => {
    f.push(f.request());
    f.push(f.request());
  });
  await authorizeLocally(f.dependencies);
  expect(f.responses).toHaveLength(1);
  expect(f.requests.filter((r) => r.url.endsWith("/token"))).toHaveLength(1);
  expect(f.counts().closes).toBe(1);
});
it("handles denied and failed token callbacks with fixed secret-free output", async () => {
  for (const denied of [true, false]) {
    const f = fixture();
    f.onOpen(() => {
      const request = f.request();
      if (denied)
        request.target = request.target.replace(
          "code=synthetic-code",
          "error=access_denied&error_description=secret",
        );
      else f.tokenError();
      f.push(request);
    });
    try {
      await authorizeLocally(f.dependencies);
      throw new Error("Expected failure");
    } catch (error) {
      expect(error).toMatchObject({ code: "authorization_failed" });
      expect(String(error)).not.toContain(secret);
    }
    expect(f.session()!.identity()).toBeUndefined();
    expect(JSON.stringify(f.responses)).not.toContain(secret);
    expect(f.counts().closes).toBe(1);
    if (denied) expect(f.requests).toHaveLength(0);
  }
});
it("cancels while waiting for callback and closes exactly once", async () => {
  const f = fixture();
  const controller = new AbortController();
  let ready!: () => void;
  const opened = new Promise<void>((resolve) => {
    ready = resolve;
  });
  f.onOpen(() => {
    ready();
  });
  const flow = authorizeLocally(f.dependencies, undefined, controller.signal);
  await opened;
  controller.abort();
  await expect(flow).rejects.toMatchObject({ code: "cancelled" });
  expect(f.counts().closes).toBe(1);
  expect(f.requests).toHaveLength(0);
});
it("expires the bounded attempt and closes a listener even when open is stalled", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    let ready!: () => void;
    const opened = new Promise<void>((resolve) => {
      ready = resolve;
    });
    f.onOpen(async () => {
      ready();
      await new Promise<void>(() => undefined);
    });
    const flow = authorizeLocally(f.dependencies);
    const failure = expect(flow).rejects.toMatchObject({ code: "timed_out" });
    await opened;
    await vi.advanceTimersByTimeAsync(LOOPBACK_LIMITS.timeoutMs);
    await failure;
    expect(f.counts().closes).toBe(1);
    expect(f.requests).toHaveLength(0);
  } finally {
    vi.useRealTimers();
  }
});
it("closes a listener that resolves after cancellation and rejects non-loopback bindings", async () => {
  const f = fixture();
  const controller = new AbortController();
  let resolve!: (bound: BoundListener) => void;
  let ready!: () => void;
  const listening = new Promise<void>((r) => {
    ready = r;
  });
  const listener = {
    listen: async () => {
      ready();
      return new Promise<BoundListener>((r) => {
        resolve = r;
      });
    },
  };
  const flow = authorizeLocally(
    { ...f.dependencies, listener },
    undefined,
    controller.signal,
  );
  const failure = expect(flow).rejects.toMatchObject({ code: "cancelled" });
  await listening;
  controller.abort();
  await failure;
  resolve(f.listener);
  await vi.waitFor(() => expect(f.counts().closes).toBe(1));
  expect(f.counts().opens).toBe(0);
  const g = fixture();
  g.dependencies.listener.listen = async () => ({
    ...g.listener,
    host: "0.0.0.0" as "127.0.0.1",
  });
  await expect(authorizeLocally(g.dependencies)).rejects.toMatchObject({
    code: "authorization_failed",
  });
  expect(g.counts()).toEqual({ closes: 1, opens: 0 });
});
it("sanitizes browser/store failures and refuses callback flooding", async () => {
  const f = fixture();
  f.dependencies.browser.open = async () => {
    throw new Error(secret);
  };
  await expect(authorizeLocally(f.dependencies)).rejects.toMatchObject({
    code: "authorization_failed",
  });
  expect(f.counts().closes).toBe(1);
  const g = fixture();
  g.dependencies.store = {
    withSession: async () => {
      throw new Error(secret);
    },
  };
  await expect(authorizeLocally(g.dependencies)).rejects.toMatchObject({
    code: "authorization_failed",
  });
  expect(g.counts().opens).toBe(0);
  const h = fixture();
  h.onOpen(() => {
    for (let i = 0; i < LOOPBACK_LIMITS.maxRequests; i++)
      h.push(h.request({ target: "/wrong" }));
    h.push(h.request());
  });
  await expect(authorizeLocally(h.dependencies)).rejects.toMatchObject({
    code: "authorization_failed",
  });
  expect(h.requests).toHaveLength(0);
  expect(h.responses).toHaveLength(16);
  expect(h.counts().closes).toBe(1);
});
it("rejects nonofficial sessions before browser opening", async () => {
  for (const authorizationEndpoint of [
    "https://other.fixture.invalid/authorize",
    "https://auth.openai.com/api/accounts/authorize",
  ]) {
    const f = fixture();
    f.dependencies.store = {
      withSession: async (_selected, _create, action) =>
        action(
          new LocalAuth(
            {
              issuer: "https://other.fixture.invalid",
              authorizationEndpoint,
              tokenEndpoint: "https://other.fixture.invalid/token",
              jwksUri: "https://other.fixture.invalid/jwks",
            },
            hostId,
            f.dependencies.transport,
          ),
        ),
    };
    await expect(authorizeLocally(f.dependencies)).rejects.toMatchObject({
      code: "authorization_failed",
    });
    expect(f.counts()).toEqual({ closes: 0, opens: 0 });
    expect(f.requests).toHaveLength(0);
  }
});

it("preserves a returning account on cancellation and performs nothing for pre-cancelled actions", async () => {
  const f = fixture();
  const identity = await authorizeLocally(f.dependencies);
  const g = fixture();
  g.dependencies.store = {
    withSession: async (_selected, _create, action) => action(f.session()!),
  };
  const controller = new AbortController();
  let ready!: () => void;
  const opened = new Promise<void>((r) => {
    ready = r;
  });
  g.onOpen(() => {
    ready();
  });
  const flow = authorizeLocally(g.dependencies, identity, controller.signal);
  await opened;
  controller.abort();
  await expect(flow).rejects.toMatchObject({ code: "cancelled" });
  expect(f.session()!.identity()).toEqual(identity);
  expect(g.counts().closes).toBe(1);
  const h = fixture();
  await expect(
    authorizeLocally(h.dependencies, undefined, controller.signal),
  ).rejects.toMatchObject({ code: "cancelled" });
  expect(h.counts()).toEqual({ closes: 0, opens: 0 });
  expect(h.session()).toBeUndefined();
});

it("bounds cleanup even when an injected listener close never resolves", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    f.dependencies.browser.open = async () => {
      throw new Error(secret);
    };
    let closes = 0;
    f.listener.close = async () => {
      closes++;
      await new Promise<void>(() => undefined);
    };
    const flow = authorizeLocally(f.dependencies);
    const failure = expect(flow).rejects.toMatchObject({
      code: "authorization_failed",
    });
    await vi.waitFor(() => expect(closes).toBe(1));
    await vi.advanceTimersByTimeAsync(LOOPBACK_LIMITS.closeTimeoutMs);
    await failure;
    expect(closes).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});
