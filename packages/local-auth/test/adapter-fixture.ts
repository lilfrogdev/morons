import { generateKeyPairSync, sign } from "node:crypto";
import { LocalSessionStore, LocalAuthService } from "../src/local-service";
import { keychainSessionIO, type StorageIntent } from "../src/keychain-broker";
import { createOpenAILocalAuth } from "../src/openai";
import type { Transport, Identity } from "../src/index";
import type { BoundListener, CallbackRequest } from "../src/loopback";
export const hostId = "urn:uuid:11111111-1111-4111-8111-111111111111";
export const secret = "synthetic-adapter-secret-never-live";
export const identity: Identity = {
  issuer: "https://auth.openai.com",
  subject: "fixture-account",
  clientId: "oaiapp_fixture",
};
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = {
  ...keys.publicKey.export({ format: "jwk" }),
  kid: "fixture",
  alg: "RS256",
  use: "sig",
};
export function adapterFixture() {
  let authorization: URL | undefined;
  const values = new Map<string, string>();
  const intents: StorageIntent[] = [];
  const writes: any[] = [];
  const calls: { url: string; init: RequestInit }[] = [];
  let expires = 3600;
  let rotation = 0;
  let failToken = false;
  let approveStorage: (intent: StorageIntent) => Promise<void> = async () => {};
  let modelReply: () => Response = () => completed();
  let floor: unknown;
  const io = keychainSessionIO(
    hostId,
    async (intent) => {
      intents.push(intent);
      await approveStorage(intent);
    },
    async (input) => {
      const request = JSON.parse(input);
      if (request.action === "write") {
        writes.push(JSON.parse(request.payload));
        values.set(request.slot, request.payload);
        return JSON.stringify({ status: "stored" });
      }
      const payload = values.get(request.slot);
      return JSON.stringify(
        payload === undefined
          ? { status: "missing" }
          : { status: "found", payload },
      );
    },
  );
  const transport: Transport = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/.well-known/jwks.json"))
      return Response.json({ keys: [jwk] });
    if (url.endsWith("/api/accounts/oauth/token")) {
      if (failToken)
        return Response.json(
          { error: "invalid_grant", error_description: secret },
          { status: 400 },
        );
      const refreshing =
        new URLSearchParams(init.body as URLSearchParams).get("grant_type") ===
        "refresh_token";
      if (refreshing) rotation++;
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(
        JSON.stringify({ alg: "RS256", kid: "fixture" }),
      ).toString("base64url");
      const body = Buffer.from(
        JSON.stringify({
          iss: identity.issuer,
          sub: identity.subject,
          aud: identity.clientId,
          iat: now,
          exp: now + 3600,
          ...(!refreshing
            ? { nonce: authorization!.searchParams.get("nonce") }
            : {}),
        }),
      ).toString("base64url");
      const signature = sign(
        "RSA-SHA256",
        Buffer.from(`${header}.${body}`),
        keys.privateKey,
      ).toString("base64url");
      return Response.json({
        access_token: `${secret}-${rotation}`,
        refresh_token: `${secret}-refresh-${rotation}`,
        id_token: `${header}.${body}.${signature}`,
        scope: "openid offline_access chatgpt.tokens.use.direct",
        expires_in: expires,
        token_type: "Bearer",
        ...(floor === undefined ? {} : { earliest_refresh_at: floor }),
      });
    }
    if (url === "https://api.openai.com/v1/models")
      return Response.json({
        models: [
          { slug: "gpt-5-mini", display_name: "Mini", visibility: "list" },
          { slug: "private", display_name: "Hidden", visibility: "hide" },
        ],
      });
    if (url === "https://api.openai.com/v1/responses") return modelReply();
    throw new Error(`Unexpected fixture transport ${url}`);
  };
  let callback: ((value: IteratorResult<CallbackRequest>) => void) | undefined;
  const listener = {
    listen: async (): Promise<BoundListener> => ({
      host: "127.0.0.1",
      port: 24680,
      requests: {
        [Symbol.asyncIterator]() {
          return {
            next: () =>
              new Promise((resolve) => {
                callback = resolve;
              }),
          };
        },
      },
      close: async () => {
        callback?.({ done: true, value: undefined });
        callback = undefined;
      },
    }),
  };
  let open: () => Promise<void> = async () => {
    callback!({
      done: false,
      value: {
        method: "GET",
        host: "127.0.0.1:24680",
        target: `/auth/callback?code=fixture&state=${authorization!.searchParams.get("state")}&client_id=${identity.clientId}`,
        headerBytes: 100,
        bodyBytes: 0,
        respond: async () => {},
      },
    });
  };
  const browser = {
    open: async (url: string) => {
      authorization = new URL(url); // Callback arrives after the coordinator requests its iterator.
      queueMicrotask(() => {
        void open();
      });
    },
  };
  // The coordinator may open before requesting the iterator; make delivery wait
  // one event-loop turn, without any real browser, sockets, or provider traffic.
  browser.open = async (url: string) => {
    authorization = new URL(url);
    setImmediate(() => {
      void open();
    });
  };
  const catalogIntents: unknown[] = [];
  let catalogApproval: () => Promise<void> = async () => {};
  const store = () => new LocalSessionStore(io);
  const service = (sessionStore = store()) =>
    new LocalAuthService({
      hostId,
      transport,
      listener,
      browser,
      store: sessionStore,
      approveCatalog: async (intent) => {
        catalogIntents.push(intent);
        await catalogApproval();
      },
    });
  const auth = async () => {
    const session = createOpenAILocalAuth(hostId, transport);
    session.attachProtectedIO(io);
    const attempt = await session.begin("http://127.0.0.1:24680/auth/callback");
    authorization = new URL(attempt.url);
    await session.complete(
      attempt.attempt,
      `http://127.0.0.1:24680/auth/callback?code=fixture&state=${authorization.searchParams.get("state")}&client_id=${identity.clientId}`,
    );
    return session;
  };
  return {
    io,
    values,
    intents,
    writes,
    calls,
    transport,
    service,
    auth,
    catalogIntents,
    expires: (value: number) => {
      expires = value;
    },
    floor: (value: unknown) => {
      floor = value;
    },
    failToken: () => {
      failToken = true;
    },
    approveStorage: (value: typeof approveStorage) => {
      approveStorage = value;
    },
    modelReply: (value: typeof modelReply) => {
      modelReply = value;
    },
    onOpen: (value: typeof open) => {
      open = value;
    },
    approveCatalog: (value: typeof catalogApproval) => {
      catalogApproval = value;
    },
  };
}
export function completed() {
  return sse([
    { type: "response.created", response: { id: "resp_fixture" } },
    {
      type: "response.completed",
      response: {
        id: "resp_fixture",
        status: "completed",
        output: [],
        usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
      },
    },
  ]);
}
export function sse(events: unknown[]) {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
