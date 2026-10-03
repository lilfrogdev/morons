import { beforeAll, expect, it, vi } from "vitest";
import {
  AuthError,
  DIRECT_SCOPE,
  LocalAuth,
  type IssuerConfiguration,
  type Transport,
} from "../src/index";
const config: IssuerConfiguration = {
  issuer: "https://issuer.fixture.invalid",
  authorizationEndpoint: "https://issuer.fixture.invalid/authorize",
  tokenEndpoint: "https://issuer.fixture.invalid/token",
  jwksUri: "https://issuer.fixture.invalid/jwks",
};
const host = "urn:uuid:11111111-1111-4111-8111-111111111111";
const redirect = "http://127.0.0.1:1455/auth/callback";
const secret = "fixture-private-never-live";
let keys: CryptoKeyPair;
let wrongKeys: CryptoKeyPair;
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
  wrongKeys = await crypto.subtle.generateKey(
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
async function jwt(claims: Record<string, unknown>, signer = keys.privateKey) {
  const message = `${b64(JSON.stringify({ alg: "RS256", kid: "fixture" }))}.${b64(JSON.stringify(claims))}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    signer,
    new TextEncoder().encode(message),
  );
  return `${message}.${b64(new Uint8Array(signature))}`;
}
function fixture() {
  const requests: { url: string; body?: URLSearchParams; init: RequestInit }[] =
    [];
  let nonce = "";
  let overrides: Record<string, unknown> = {};
  let responseOverrides: Record<string, unknown> = {};
  let wrongSignature = false;
  let fail = false;
  let exp = 120;
  let rotation = 0;
  let omitRefreshIdentity = false;
  let transportOverride: Transport | undefined;
  const transport: Transport = async (url, init) => {
    requests.push({
      url,
      body:
        init.body instanceof URLSearchParams
          ? new URLSearchParams(init.body)
          : undefined,
      init,
    });
    if (transportOverride) return transportOverride(url, init);
    if (url === config.jwksUri) return Response.json({ keys: [jwk] });
    if (fail)
      return Response.json(
        { error: "invalid_grant", error_description: secret },
        { status: 400 },
      );
    const body = new URLSearchParams(init.body as URLSearchParams);
    const refresh = body.get("grant_type") === "refresh_token";
    if (refresh) rotation++;
    const now = Math.floor(Date.now() / 1000);
    const id = await jwt(
      {
        iss: config.issuer,
        aud: "oaiapp_fixture",
        sub: "fixture-account",
        iat: now,
        exp: now + 3600,
        ...(refresh ? {} : { nonce }),
        ...overrides,
      },
      wrongSignature ? wrongKeys.privateKey : keys.privateKey,
    );
    return Response.json({
      access_token: `${secret}-access-${rotation}`,
      refresh_token: `${secret}-refresh-${rotation}`,
      ...(refresh && omitRefreshIdentity ? {} : { id_token: id }),
      expires_in: exp,
      token_type: "Bearer",
      scope: `openid offline_access ${DIRECT_SCOPE}`,
      ...responseOverrides,
    });
  };
  const auth = new LocalAuth(config, host, transport);
  const begin = async () => {
    const pending = await auth.begin(redirect);
    nonce = new URL(pending.url).searchParams.get("nonce")!;
    const state = new URL(pending.url).searchParams.get("state")!;
    return {
      ...pending,
      callback: `${redirect}?code=synthetic-code&state=${state}&client_id=oaiapp_fixture`,
    };
  };
  return {
    auth,
    requests,
    begin,
    setClaims: (v: Record<string, unknown>) => {
      overrides = v;
    },
    setResponse: (v: Record<string, unknown>) => {
      responseOverrides = v;
    },
    badSignature: () => {
      wrongSignature = true;
    },
    setFail: () => {
      fail = true;
    },
    expires: (v: number) => {
      exp = v;
    },
    omitRefreshIdentity: () => {
      omitRefreshIdentity = true;
    },
    overrideTransport: (value: Transport) => {
      transportOverride = value;
    },
  };
}
it("generates fresh library PKCE/state/nonce with actual name and stable host; never dispatches on begin", async () => {
  const f = fixture();
  const first = await f.begin();
  const second = await f.begin();
  const a = new URL(first.url).searchParams;
  const b = new URL(second.url).searchParams;
  expect(a.get("client_id")).toBe("dynamic_agent_client");
  expect(a.get("agent_name_hint")).toBe("Morons");
  expect(a.get("ext_agent_host_id")).toBe(host);
  expect(a.get("code_challenge_method")).toBe("S256");
  for (const name of ["state", "nonce", "code_challenge"])
    expect(a.get(name)).not.toBe(b.get(name));
  expect(f.requests).toHaveLength(0);
  expect(JSON.stringify(first.attempt)).not.toContain(a.get("nonce")!);
});
it("exchanges with exact callback/client/resource and validates JWKS before storing identity", async () => {
  const f = fixture();
  const pending = await f.begin();
  expect(await f.auth.complete(pending.attempt, pending.callback)).toEqual({
    issuer: config.issuer,
    subject: "fixture-account",
    clientId: "oaiapp_fixture",
  });
  expect(f.requests.map((r) => r.url)).toEqual([
    config.tokenEndpoint,
    config.jwksUri,
  ]);
  const body = f.requests[0].body!;
  expect(body.get("redirect_uri")).toBe(redirect);
  expect(body.get("client_id")).toBe("oaiapp_fixture");
  expect(body.get("resource")).toBe("https://api.openai.com/v1");
  expect(body.has("client_secret")).toBe(false);
  const challenge = b64(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(body.get("code_verifier")!),
      ),
    ),
  );
  expect(challenge).toBe(
    new URL(pending.url).searchParams.get("code_challenge"),
  );
  expect(JSON.stringify(f.auth)).not.toContain(secret);
  await expect(
    f.auth.complete(pending.attempt, pending.callback),
  ).rejects.toBeInstanceOf(AuthError);
  expect(f.requests).toHaveLength(2);
});
it("rejects wrong state, denied callback, redirect changes, duplicate params and missing issued client before transport", async () => {
  for (const change of [
    (url: URL) => url.searchParams.set("state", "wrong"),
    (url: URL) => url.searchParams.set("error", "access_denied"),
    (url: URL) => {
      url.hostname = "localhost";
    },
    (url: URL) => {
      url.port = "1456";
    },
    (url: URL) => url.searchParams.append("state", "duplicate"),
    (url: URL) => url.searchParams.delete("client_id"),
    (url: URL) => url.searchParams.set("client_id", "dynamic_agent_client"),
  ]) {
    const f = fixture();
    const p = await f.begin();
    const url = new URL(p.callback);
    change(url);
    await expect(f.auth.complete(p.attempt, url.href)).rejects.toBeInstanceOf(
      AuthError,
    );
    expect(f.requests).toHaveLength(0);
    expect(f.auth.identity()).toBeUndefined();
  }
});
it("rejects forged attempt, cross-session attempt and expired attempt", async () => {
  const a = fixture(),
    b = fixture();
  const p = await a.begin();
  await expect(b.auth.complete(p.attempt, p.callback)).rejects.toBeInstanceOf(
    AuthError,
  );
  await expect(
    a.auth.complete(
      { toJSON: () => ({ type: "authorization_attempt" }) },
      p.callback,
    ),
  ).rejects.toBeInstanceOf(AuthError);
  const original = Date.now;
  Date.now = () => original() + 300001;
  try {
    await expect(a.auth.complete(p.attempt, p.callback)).rejects.toBeInstanceOf(
      AuthError,
    );
  } finally {
    Date.now = original;
  }
  expect(a.requests).toHaveLength(0);
  expect(b.requests).toHaveLength(0);
});
it("rejects nonce, issuer, audience, expiry, subject, scope and actual invalid signatures", async () => {
  for (const claims of [
    { nonce: "wrong" },
    { iss: "https://wrong.fixture.invalid" },
    { aud: "other-client" },
    { exp: Math.floor(Date.now() / 1000) - 1 },
    { sub: "" },
  ]) {
    const f = fixture();
    const p = await f.begin();
    f.setClaims(claims);
    await expect(f.auth.complete(p.attempt, p.callback)).rejects.toBeInstanceOf(
      AuthError,
    );
    expect(f.auth.identity()).toBeUndefined();
  }
  for (const override of [
    { scope: "openid" },
    { id_token: undefined },
    { expires_in: -1 },
  ]) {
    const f = fixture();
    const p = await f.begin();
    f.setResponse(override);
    await expect(f.auth.complete(p.attempt, p.callback)).rejects.toBeInstanceOf(
      AuthError,
    );
    expect(f.auth.identity()).toBeUndefined();
  }
  const f = fixture();
  const p = await f.begin();
  f.badSignature();
  await expect(f.auth.complete(p.attempt, p.callback)).rejects.toBeInstanceOf(
    AuthError,
  );
  expect(f.requests.some((r) => r.url === config.jwksUri)).toBe(true);
  expect(f.auth.identity()).toBeUndefined();
});
it("reuses issued-client workspace registration and rejects changed client or account without replacing current identity", async () => {
  const f = fixture();
  const initial = await f.begin();
  await f.auth.complete(initial.attempt, initial.callback);
  const original = f.auth.identity();
  let p = await f.begin();
  let url = new URL(p.url);
  expect(url.searchParams.get("client_id")).toBe("oaiapp_fixture");
  expect(url.searchParams.has("agent_name_hint")).toBe(false);
  const callback = new URL(p.callback);
  callback.searchParams.delete("client_id");
  await f.auth.complete(p.attempt, callback.href);
  expect(f.auth.identity()).toEqual(original);
  p = await f.begin();
  const changed = new URL(p.callback);
  changed.searchParams.set("client_id", "oaiapp_other_workspace");
  const before = f.requests.length;
  await expect(f.auth.complete(p.attempt, changed.href)).rejects.toBeInstanceOf(
    AuthError,
  );
  expect(f.requests).toHaveLength(before);
  p = await f.begin();
  f.setClaims({ sub: "different-account" });
  await expect(f.auth.complete(p.attempt, p.callback)).rejects.toBeInstanceOf(
    AuthError,
  );
  expect(f.auth.identity()).toEqual(original);
});
it("serializes rotating refreshes and uses newest token, retained scope and issued client", async () => {
  const f = fixture();
  const p = await f.begin();
  await f.auth.complete(p.attempt, p.callback);
  f.expires(3600);
  f.setResponse({ scope: undefined });
  await Promise.all([f.auth.refresh(), f.auth.refresh(), f.auth.refresh()]);
  let refreshes = f.requests.filter(
    (r) => r.body?.get("grant_type") === "refresh_token",
  );
  expect(refreshes).toHaveLength(1);
  expect(refreshes[0].body!.get("refresh_token")).toBe(`${secret}-refresh-0`);
  expect(refreshes[0].body!.get("client_id")).toBe("oaiapp_fixture");
  expect(refreshes[0].body!.has("scope")).toBe(false);
  const original = Date.now;
  Date.now = () => original() + 3600000;
  try {
    f.omitRefreshIdentity();
    await f.auth.refresh();
  } finally {
    Date.now = original;
  }
  refreshes = f.requests.filter(
    (r) => r.body?.get("grant_type") === "refresh_token",
  );
  expect(refreshes[1].body!.get("refresh_token")).toBe(`${secret}-refresh-1`);
  expect(f.auth.identity()!.subject).toBe("fixture-account");
});
it("blocks uncertain refresh retries and rejects changed refresh identity or scope", async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => f.setClaims({ sub: "other" }),
    (f: ReturnType<typeof fixture>) => f.setClaims({ nonce: "other" }),
    (f: ReturnType<typeof fixture>) =>
      f.setClaims({ iss: "https://other.fixture.invalid" }),
    (f: ReturnType<typeof fixture>) =>
      f.setClaims({ aud: "oaiapp_other_workspace" }),
    (f: ReturnType<typeof fixture>) =>
      f.setClaims({ exp: Math.floor(Date.now() / 1000) - 1 }),
    (f: ReturnType<typeof fixture>) => f.setResponse({ scope: "openid" }),
    (f: ReturnType<typeof fixture>) => f.setFail(),
    (f: ReturnType<typeof fixture>) => f.badSignature(),
  ]) {
    const f = fixture();
    const p = await f.begin();
    await f.auth.complete(p.attempt, p.callback);
    change(f);
    await expect(f.auth.refresh()).rejects.toMatchObject({
      code: "reauth_required",
    });
    const before = f.requests.length;
    await expect(f.auth.refresh()).rejects.toMatchObject({
      code: "reauth_required",
    });
    expect(f.requests).toHaveLength(before);
    expect(f.auth.identity()!.subject).toBe("fixture-account");
  }
});
it("redacts provider/transport errors and propagates cancellation without storing a result", async () => {
  for (const fail of [true, false]) {
    const f = fixture();
    const p = await f.begin();
    if (fail) f.setFail();
    else
      f.overrideTransport(async () => {
        throw new Error(secret);
      });
    try {
      await f.auth.complete(p.attempt, p.callback);
      throw new Error("Expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AuthError);
      expect(String(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  }
  const f = fixture();
  const p = await f.begin();
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.overrideTransport(async (_url, init) => {
    started();
    return new Promise((_, reject) =>
      init.signal!.addEventListener("abort", () => reject(new Error(secret)), {
        once: true,
      }),
    );
  });
  const completion = f.auth.complete(p.attempt, p.callback, controller.signal);
  await ready;
  controller.abort();
  await expect(completion).rejects.toMatchObject({ code: "cancelled" });
  expect(f.auth.identity()).toBeUndefined();
});

it("rejects oversized/redirected bodies and stale concurrent registrations", async () => {
  for (const response of [
    new Response("x".repeat(65537)),
    new Response(null, {
      status: 302,
      headers: { Location: "https://other.fixture.invalid" },
    }),
  ]) {
    const f = fixture();
    const p = await f.begin();
    f.overrideTransport(async () => response);
    await expect(f.auth.complete(p.attempt, p.callback)).rejects.toBeInstanceOf(
      AuthError,
    );
    expect(f.auth.identity()).toBeUndefined();
  }
  const f = fixture();
  const a = await f.begin();
  const b = await f.begin();
  // begin() never dispatches; align fixture issuer nonce to first pending attempt.
  f.setClaims({ nonce: new URL(a.url).searchParams.get("nonce") });
  await f.auth.complete(a.attempt, a.callback);
  const before = f.requests.length;
  await expect(f.auth.complete(b.attempt, b.callback)).rejects.toBeInstanceOf(
    AuthError,
  );
  expect(f.requests).toHaveLength(before);
});

it("rejects an attempt whose PKCE hashing races a completed registration", async () => {
  const f = fixture();
  const first = await f.begin();
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = vi
    .spyOn(crypto.subtle, "digest")
    .mockImplementation(async (...args) => {
      await gate;
      return digest(...args);
    });
  try {
    const racingBegin = f.begin();
    await f.auth.complete(first.attempt, first.callback);
    expect(f.auth.identity()!.subject).toBe("fixture-account");
    release();
    const racing = await racingBegin;
    f.setClaims({ sub: "different-account" });
    const before = f.requests.length;
    await expect(
      f.auth.complete(racing.attempt, racing.callback),
    ).rejects.toBeInstanceOf(AuthError);
    expect(f.auth.identity()!.subject).toBe("fixture-account");
    expect(f.requests).toHaveLength(before);
  } finally {
    release();
    spy.mockRestore();
  }
});
