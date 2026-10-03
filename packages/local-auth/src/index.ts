import * as oauth from "oauth4webapi";

export const DIRECT_SCOPE = "chatgpt.tokens.use.direct";
const RESOURCE = "https://api.openai.com/v1";
const SCOPES = `openid profile email offline_access resource.invoke ${DIRECT_SCOPE}`;
export type Transport = (url: string, init: RequestInit) => Promise<Response>;
export interface IssuerConfiguration {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
}
export interface Identity {
  issuer: string;
  subject: string;
  clientId: string;
}
interface Tokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresAt: number;
  scopes: string[];
  identity: Identity;
  nonce: string;
}
export class AuthError extends Error {
  constructor(
    readonly code:
      | "invalid_attempt"
      | "cancelled"
      | "validation_failed"
      | "reauth_required",
  ) {
    super(`ChatGPT sign-in ${code.replaceAll("_", " ")}.`);
    this.name = "AuthError";
  }
}
function requireValue(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 16384 ||
    /[\x00-\x20\x7f]/.test(value)
  )
    throw new AuthError("validation_failed");
}
function clientId(value: unknown): asserts value is string {
  requireValue(value);
  if (value === "dynamic_agent_client" || !/^[A-Za-z0-9_-]{1,256}$/.test(value))
    throw new AuthError("validation_failed");
}
function callbackUri(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.pathname !== "/auth/callback" ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new AuthError("invalid_attempt");
  return url.href;
}

interface Pending {
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  clientId?: string;
  identity?: Identity;
  expiresAt: number;
  owner: LocalAuth;
  revision: number;
}
export interface Attempt {
  toJSON(): { type: string };
}
const attempts = new WeakMap<Attempt, Pending>();

// Local-only, memory-only auth foundation. Transport is mandatory and injected;
// no ambient credential lookup, browser launch, listener, persistence or inference.
export class LocalAuth {
  #server: oauth.AuthorizationServer;
  #transport: Transport;
  #hostId: string;
  #tokens?: Tokens;
  #queue: Promise<unknown> = Promise.resolve();
  #refreshBlocked = false;
  #revision = 0;
  constructor(
    configuration: IssuerConfiguration,
    hostId: string,
    transport: Transport,
  ) {
    try {
      for (const value of Object.values(configuration)) {
        const url = new URL(value);
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new AuthError("invalid_attempt");
      }
      if (
        !/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          hostId,
        )
      )
        throw new AuthError("invalid_attempt");
    } catch {
      throw new AuthError("invalid_attempt");
    }
    this.#hostId = hostId;
    this.#transport = transport;
    this.#server = {
      issuer: configuration.issuer,
      authorization_endpoint: configuration.authorizationEndpoint,
      token_endpoint: configuration.tokenEndpoint,
      jwks_uri: configuration.jwksUri,
      id_token_signing_alg_values_supported: ["RS256"],
    };
  }
  toJSON() {
    return { type: "local_chatgpt_auth", connected: Boolean(this.#tokens) };
  }
  identity() {
    return this.#tokens ? { ...this.#tokens.identity } : undefined;
  }
  #client(id: string): oauth.Client {
    return {
      client_id: id,
      id_token_signed_response_alg: "RS256",
      [oauth.clockTolerance]: 0,
    };
  }
  #options(signal?: AbortSignal) {
    const bounded = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000);
    return {
      signal: bounded,
      [oauth.customFetch]: async (url: string, init: RequestInit) => {
        if (
          url !== this.#server.token_endpoint &&
          url !== this.#server.jwks_uri
        )
          throw new AuthError("validation_failed");
        bounded.throwIfAborted();
        const response = await this.#transport(url, {
          ...init,
          signal: bounded,
          redirect: "error",
        });
        bounded.throwIfAborted();
        if (response.status >= 300 && response.status < 400)
          throw new AuthError("validation_failed");
        // Bound error/token/JWKS bodies before the library parses them.
        const reader = response.body?.getReader();
        if (!reader) throw new AuthError("validation_failed");
        const parts: Uint8Array[] = [];
        let size = 0;
        const cancelReader = () => {
          void reader.cancel().catch(() => undefined);
        };
        bounded.addEventListener("abort", cancelReader, { once: true });
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 65536) throw new AuthError("validation_failed");
            parts.push(value);
            bounded.throwIfAborted();
          }
          bounded.throwIfAborted();
        } finally {
          bounded.removeEventListener("abort", cancelReader);
          await reader.cancel().catch(() => undefined);
        }
        return new Response(new Blob(parts as BlobPart[]), {
          status: response.status,
          headers: response.headers,
        });
      },
    };
  }
  async begin(redirectUri: string) {
    try {
      const redirect = callbackUri(redirectUri);
      const state = oauth.generateRandomState();
      const nonce = oauth.generateRandomNonce();
      const verifier = oauth.generateRandomCodeVerifier();
      // Snapshot account identity and generation before PKCE hashing yields.
      // A concurrent registration must not lend its revision to this attempt.
      const saved = this.#tokens ? { ...this.#tokens.identity } : undefined;
      const revision = this.#revision;
      const url = new URL(this.#server.authorization_endpoint!);
      for (const [name, value] of Object.entries({
        client_id: saved?.clientId ?? "dynamic_agent_client",
        ext_agent_host_id: this.#hostId,
        response_type: "code",
        redirect_uri: redirect,
        scope: SCOPES,
        resource: RESOURCE,
        state,
        nonce,
        code_challenge_method: "S256",
        code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
      }))
        url.searchParams.set(name, value);
      if (!saved) url.searchParams.set("agent_name_hint", "Morons");
      const attempt = Object.freeze({
        toJSON: () => ({ type: "authorization_attempt" }),
      });
      attempts.set(attempt, {
        state,
        nonce,
        verifier,
        redirectUri: redirect,
        clientId: saved?.clientId,
        identity: saved ? { ...saved } : undefined,
        expiresAt: Date.now() + 300000,
        owner: this,
        revision,
      });
      return { url: url.href, attempt };
    } catch {
      throw new AuthError("invalid_attempt");
    }
  }
  #serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  #record(
    result: oauth.TokenEndpointResponse,
    client: string,
    nonce: string,
    previous?: Tokens,
  ): Tokens {
    const claims = oauth.getValidatedIdTokenClaims(result);
    if (!claims && !previous) throw new AuthError("validation_failed");
    if (claims) {
      requireValue(claims.sub);
      if (
        previous &&
        claims.nonce !== undefined &&
        claims.nonce !== previous.nonce
      )
        throw new AuthError("validation_failed");
    }
    const identity = {
      issuer: this.#server.issuer,
      subject: claims?.sub ?? previous!.identity.subject,
      clientId: client,
    };
    if (
      previous &&
      (identity.subject !== previous.identity.subject ||
        identity.issuer !== previous.identity.issuer ||
        identity.clientId !== previous.identity.clientId)
    )
      throw new AuthError("validation_failed");
    const scopes = (result.scope ?? previous?.scopes.join(" ") ?? "").split(
      " ",
    );
    if (!scopes.includes(DIRECT_SCOPE))
      throw new AuthError("validation_failed");
    requireValue(result.access_token);
    const idToken = result.id_token ?? previous?.idToken;
    requireValue(idToken);
    const refresh = result.refresh_token ?? previous?.refreshToken;
    requireValue(refresh);
    if (
      typeof result.expires_in !== "number" ||
      !Number.isFinite(result.expires_in) ||
      result.expires_in <= 0 ||
      result.expires_in > 86400
    )
      throw new AuthError("validation_failed");
    return {
      identity,
      accessToken: result.access_token,
      refreshToken: refresh,
      idToken,
      nonce,
      expiresAt: Date.now() + result.expires_in * 1000,
      scopes,
    };
  }
  complete(attempt: Attempt, callback: string, signal?: AbortSignal) {
    return this.#serialize(async () => {
      try {
        signal?.throwIfAborted();
        const pending = attempts.get(attempt);
        if (
          !pending ||
          pending.owner !== this ||
          pending.revision !== this.#revision ||
          Date.now() > pending.expiresAt
        )
          throw new AuthError("invalid_attempt");
        attempts.delete(attempt);
        const url = new URL(callback);
        if (
          url.origin + url.pathname !== pending.redirectUri ||
          url.hash ||
          url.username ||
          url.password
        )
          throw new AuthError("invalid_attempt");
        for (const name of ["code", "state", "client_id", "error"])
          if (url.searchParams.getAll(name).length > 1)
            throw new AuthError("invalid_attempt");
        const supplied = url.searchParams.get("client_id");
        const id = supplied ?? pending.clientId;
        clientId(id);
        if (pending.clientId && id !== pending.clientId)
          throw new AuthError("validation_failed");
        const client = this.#client(id);
        const params = oauth.validateAuthResponse(
          this.#server,
          client,
          url,
          pending.state,
        );
        const options = this.#options(signal);
        const response = await oauth.authorizationCodeGrantRequest(
          this.#server,
          client,
          oauth.None(),
          params,
          pending.redirectUri,
          pending.verifier,
          { ...options, additionalParameters: { resource: RESOURCE } },
        );
        const result = await oauth.processAuthorizationCodeResponse(
          this.#server,
          client,
          response,
          { expectedNonce: pending.nonce, requireIdToken: true },
        );
        await oauth.validateApplicationLevelSignature(
          this.#server,
          response,
          options,
        );
        signal?.throwIfAborted();
        const record = this.#record(result, id, pending.nonce);
        if (
          pending.identity &&
          (record.identity.subject !== pending.identity.subject ||
            record.identity.issuer !== pending.identity.issuer ||
            record.identity.clientId !== pending.identity.clientId)
        )
          throw new AuthError("validation_failed");
        this.#tokens = record;
        this.#refreshBlocked = false;
        this.#revision++;
        return this.identity()!;
      } catch {
        throw new AuthError(
          signal?.aborted ? "cancelled" : "validation_failed",
        );
      }
    });
  }
  // One session owns the rotation lock; persistence/multi-process locks are not
  // implemented here. A failed/uncertain refresh requires explicit reauthorization.
  refresh(signal?: AbortSignal) {
    return this.#serialize(async () => {
      const previous = this.#tokens;
      if (!previous || this.#refreshBlocked)
        throw new AuthError("reauth_required");
      if (signal?.aborted) throw new AuthError("cancelled");
      if (previous.expiresAt > Date.now() + 180000) return this.identity()!;
      try {
        const client = this.#client(previous.identity.clientId);
        const options = this.#options(signal);
        const response = await oauth.refreshTokenGrantRequest(
          this.#server,
          client,
          oauth.None(),
          previous.refreshToken,
          { ...options, additionalParameters: { resource: RESOURCE } },
        );
        const result = await oauth.processRefreshTokenResponse(
          this.#server,
          client,
          response,
        );
        if (result.id_token)
          await oauth.validateApplicationLevelSignature(
            this.#server,
            response,
            options,
          );
        signal?.throwIfAborted();
        this.#tokens = this.#record(
          result,
          client.client_id,
          previous.nonce,
          previous,
        );
        return this.identity()!;
      } catch {
        this.#refreshBlocked = true;
        throw new AuthError(signal?.aborted ? "cancelled" : "reauth_required");
      }
    });
  }
}
