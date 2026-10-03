import { AuthError, LocalAuth, type Identity, type Transport } from "./index";
import { createOpenAILocalAuth, isOpenAILocalAuth } from "./openai";

export const LOOPBACK_LIMITS = Object.freeze({
  timeoutMs: 300000,
  maxHeaderBytes: 8192,
  maxTargetBytes: 8192,
  maxRequests: 16,
  maxPendingRequests: 1,
  closeTimeoutMs: 1000,
});
const AUTHORIZE = "https://auth.openai.com/api/accounts/authorize";
const CALLBACK_PATH = "/auth/callback";
const SUCCESS =
  "<!doctype html><title>Morons</title><p>Sign-in complete. Return to Morons.</p>";
const FAILURE =
  "<!doctype html><title>Morons</title><p>Sign-in was not completed. Return to Morons.</p>";
export interface CallbackRequest {
  method: string;
  // Raw origin-form request target, not an absolute URL or reconstructed callback.
  target: string;
  host: string;
  headerBytes: number;
  bodyBytes: number;
  respond(status: number, html: string): Promise<void>;
}
export interface BoundListener {
  host: "127.0.0.1";
  port: number;
  requests: AsyncIterable<CallbackRequest>;
  close(): Promise<void>;
}
export interface LoopbackListenerFactory {
  // Implementations must enforce these bounds before buffering HTTP requests.
  listen(
    options: {
      host: "127.0.0.1";
      port: 0;
      maxHeaderBytes: number;
      maxPendingRequests: number;
    },
    signal: AbortSignal,
  ): Promise<BoundListener>;
}
export interface BrowserOpener {
  open(authorizationUrl: string, signal: AbortSignal): Promise<void>;
}
// A protected store brokers an opaque auth session; no tokens enter coordinator
// DTOs. The implementation must select the exact registration, own its rotation
// lock and atomically retain only successfully validated state. No disk/Keychain
// implementation or credential serialization is provided by this slice.
export interface ProtectedSessionStore {
  withSession<T>(
    selected: Identity | undefined,
    create: () => LocalAuth,
    action: (session: LocalAuth) => Promise<T>,
  ): Promise<T>;
}
export class FlowError extends Error {
  constructor(
    readonly code: "cancelled" | "timed_out" | "authorization_failed",
  ) {
    super(`ChatGPT sign-in ${code.replaceAll("_", " ")}.`);
    this.name = "FlowError";
  }
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new FlowError("cancelled"));
    if (signal.aborted) {
      reject(new FlowError("cancelled"));
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
function matches(a: Identity | undefined, b: Identity | undefined) {
  return (
    a?.issuer === b?.issuer &&
    a?.subject === b?.subject &&
    a?.clientId === b?.clientId
  );
}

// Source-only coordinator. Every OS, network and protected-store capability is
// injected; nothing binds a port, opens a browser or reads credentials on import.
export async function authorizeLocally(
  dependencies: {
    hostId: string;
    transport: Transport;
    listener: LoopbackListenerFactory;
    browser: BrowserOpener;
    store: ProtectedSessionStore;
  },
  selected?: Identity,
  signal?: AbortSignal,
): Promise<Identity> {
  const registration = selected ? Object.freeze({ ...selected }) : undefined;
  const controller = new AbortController();
  let timedOut = false;
  let listener: BoundListener | undefined;
  const closed = new WeakSet<BoundListener>();
  const closeOnce = async (bound: BoundListener) => {
    if (closed.has(bound)) return;
    closed.add(bound);
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => bound.close()),
        new Promise<void>((resolve) => {
          cleanupTimer = setTimeout(resolve, LOOPBACK_LIMITS.closeTimeoutMs);
        }),
      ]);
    } catch {
      /* Cleanup failures cannot disclose listener diagnostics. */
    } finally {
      clearTimeout(cleanupTimer);
    }
  };
  const cancel = () => controller.abort();
  if (signal?.aborted) throw new FlowError("cancelled");
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, LOOPBACK_LIMITS.timeoutMs);
  const operation = controller.signal;
  try {
    return await abortable(
      dependencies.store.withSession(
        registration,
        () =>
          createOpenAILocalAuth(dependencies.hostId, dependencies.transport),
        async (auth) => {
          operation.throwIfAborted();
          if (
            !isOpenAILocalAuth(auth) ||
            !matches(auth.identity(), registration)
          )
            throw new AuthError("invalid_attempt");
          // A cancelled listen that resolves late must still release its bound port.
          const pendingListener = dependencies.listener.listen(
            {
              host: "127.0.0.1",
              port: 0,
              maxHeaderBytes: LOOPBACK_LIMITS.maxHeaderBytes,
              maxPendingRequests: LOOPBACK_LIMITS.maxPendingRequests,
            },
            operation,
          );
          pendingListener.then(
            (bound) => {
              listener = bound;
              if (operation.aborted) void closeOnce(bound);
            },
            () => undefined,
          );
          listener = await abortable(pendingListener, operation);
          if (
            listener.host !== "127.0.0.1" ||
            !Number.isInteger(listener.port) ||
            listener.port < 1 ||
            listener.port > 65535
          )
            throw new AuthError("invalid_attempt");
          const authority = `127.0.0.1:${listener.port}`;
          const redirectUri = `http://${authority}${CALLBACK_PATH}`;
          const pending = await abortable(auth.begin(redirectUri), operation);
          const authorization = new URL(pending.url);
          if (
            authorization.origin + authorization.pathname !== AUTHORIZE ||
            authorization.username ||
            authorization.password ||
            authorization.hash ||
            authorization.searchParams.get("redirect_uri") !== redirectUri
          )
            throw new AuthError("invalid_attempt");
          const state = authorization.searchParams.get("state");
          if (!state) throw new AuthError("invalid_attempt");
          await abortable(
            dependencies.browser.open(pending.url, operation),
            operation,
          );
          const iterator = listener.requests[Symbol.asyncIterator]();
          for (let count = 0; count < LOOPBACK_LIMITS.maxRequests; count++) {
            const next = await abortable(iterator.next(), operation);
            if (next.done) throw new AuthError("invalid_attempt");
            const request = next.value;
            const reject = (status: number) =>
              abortable(request.respond(status, FAILURE), operation);
            if (
              !Number.isInteger(request.headerBytes) ||
              request.headerBytes < 0 ||
              request.headerBytes > LOOPBACK_LIMITS.maxHeaderBytes ||
              new TextEncoder().encode(request.target).byteLength >
                LOOPBACK_LIMITS.maxTargetBytes
            ) {
              await reject(431);
              continue;
            }
            if (
              request.method !== "GET" ||
              request.bodyBytes !== 0 ||
              request.host !== authority ||
              !request.target.startsWith("/") ||
              request.target.startsWith("//") ||
              /[\\\x00-\x20\x7f]/.test(request.target)
            ) {
              await reject(400);
              continue;
            }
            const url = new URL(request.target, redirectUri);
            // Compare the raw path too: URL normalization cannot rescue substitutions.
            if (
              request.target.split("?")[0] !== CALLBACK_PATH ||
              url.origin !== `http://${authority}` ||
              url.pathname !== CALLBACK_PATH ||
              url.hash
            ) {
              await reject(404);
              continue;
            }
            if (
              url.searchParams.get("state") !== state ||
              ["code", "state", "client_id", "error"].some(
                (name) => url.searchParams.getAll(name).length > 1,
              )
            ) {
              await reject(403);
              continue;
            }
            // The first correctly bound terminal callback consumes the attempt. Errors
            // and replay can never turn into another authorization or code exchange.
            try {
              const identity = await abortable(
                auth.complete(pending.attempt, url.href, operation),
                operation,
              );
              if (identity.issuer !== "https://auth.openai.com")
                throw new AuthError("validation_failed");
              await abortable(request.respond(200, SUCCESS), operation);
              return identity;
            } catch {
              if (!operation.aborted) await reject(400);
              throw new AuthError("validation_failed");
            }
          }
          throw new AuthError("invalid_attempt");
        },
      ),
      operation,
    );
  } catch {
    throw new FlowError(
      timedOut
        ? "timed_out"
        : signal?.aborted
          ? "cancelled"
          : "authorization_failed",
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    controller.abort();
    if (listener) await closeOnce(listener);
  }
}
