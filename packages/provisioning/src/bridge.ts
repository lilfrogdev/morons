import { pathToFileURL } from "node:url";
import { Provisioner, ProvisioningError } from "./index.js";
import type {
  ScopedTokenSource,
  DeploymentConfirmation,
  WorkerBundle,
} from "./index.js";

export const MAX_FRAME_BYTES = 6 * 1024 * 1024;
export const SESSION_LIFETIME_MS = 10 * 60_000;
type Reply =
  | { id: number | null; ok: true; result: unknown }
  | {
      id: number | null;
      ok: false;
      error: {
        code: string;
        stage: string;
        writeState: string;
        httpStatus: number | null;
        providerCodes: readonly number[];
      };
    };
function errorReply(id: number | null, error: unknown): Reply {
  const safe =
    error instanceof ProvisioningError
      ? error
      : new ProvisioningError("invalid_input", "confirmation");
  return {
    id,
    ok: false,
    error: {
      code: safe.code,
      stage: safe.stage,
      writeState: safe.writeState,
      httpStatus: safe.httpStatus ?? null,
      providerCodes: safe.providerCodes,
    },
  };
}

// Library entry point permits fake fetch/clock in tests. Only the explicit stdio
// executable mode uses the real Cloudflare transport; it never loads credentials.
export class BridgeSession {
  #provisioner: Provisioner | undefined;
  #clearToken: (() => void) | undefined;
  #expiresAt = 0;
  #now: () => number;
  #fetch: typeof fetch;
  #closed = false;
  #expiryTimer: NodeJS.Timeout | undefined;
  constructor(options: { fetch?: typeof fetch; now?: () => number } = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }
  get closed(): boolean {
    return this.#closed;
  }
  dispose(): void {
    if (this.#expiryTimer) clearTimeout(this.#expiryTimer);
    this.#expiryTimer = undefined;
    this.#clearToken?.();
    this.#clearToken = undefined;
    this.#provisioner = undefined;
    this.#expiresAt = 0;
  }
  async handle(frame: unknown): Promise<Reply> {
    let id: number | null = null;
    try {
      if (!frame || typeof frame !== "object" || Array.isArray(frame))
        throw new ProvisioningError("invalid_input", "confirmation");
      const request = frame as Record<string, unknown>;
      if (
        typeof request.id !== "number" ||
        !Number.isSafeInteger(request.id) ||
        request.id <= 0
      )
        throw new ProvisioningError("invalid_input", "confirmation");
      id = request.id;
      if (this.#closed)
        throw new ProvisioningError("approval_required", "confirmation");
      if (this.#expiresAt <= this.#now()) this.dispose();
      let result: unknown;
      switch (request.op) {
        case "connect": {
          this.dispose();
          if (
            request.credentialEntryApproved !== true ||
            request.scopeConfirmed !== true ||
            typeof request.token !== "string" ||
            !/^[A-Za-z0-9_-]{20,256}$/.test(request.token) ||
            !Array.isArray(request.accountIds)
          )
            throw new ProvisioningError("credential_scope", "accounts");
          let token: string | undefined = request.token;
          const source: ScopedTokenSource = {
            kind: "scoped-api-token",
            accountIds: request.accountIds,
            withToken: async (use) => {
              if (!token || this.#expiresAt <= this.#now())
                throw new ProvisioningError("approval_required", "accounts");
              return use(token);
            },
          };
          this.#provisioner = new Provisioner(source, {
            fetch: this.#fetch,
            now: this.#now,
          });
          this.#clearToken = () => {
            token = undefined;
          };
          this.#expiresAt = this.#now() + SESSION_LIFETIME_MS;
          this.#expiryTimer = setTimeout(
            () => this.dispose(),
            SESSION_LIFETIME_MS,
          );
          this.#expiryTimer.unref();
          result = { state: "connected", expiresAt: this.#expiresAt };
          break;
        }
        case "listAccounts":
          result = await this.#connected().listAccounts();
          break;
        case "prepare":
          result = await this.#connected().prepareDeployment({
            accountId: request.accountId as string,
            workerName: request.workerName as string,
            bundle: request.bundle as WorkerBundle,
            selection: request.selection,
          });
          break;
        case "deploy": {
          const bootstrap = request.bootstrap;
          if (
            !bootstrap ||
            typeof bootstrap !== "object" ||
            Array.isArray(bootstrap)
          )
            throw new ProvisioningError("invalid_input", "bootstrap");
          const secrets = bootstrap as {
            AUTH_TOKEN: string;
            providerKey: string;
          };
          result = await this.#connected().deploy(
            request.confirmation as DeploymentConfirmation,
            { withSecrets: async (use) => use(secrets) },
          );
          break;
        }
        case "status":
          result = await this.#connected().getDeploymentStatus(
            request.accountId as string,
            request.workerName as string,
          );
          break;
        case "close":
          this.dispose();
          this.#closed = true;
          result = { state: "closed" };
          break;
        default:
          throw new ProvisioningError("invalid_input", "confirmation");
      }
      return { id, ok: true, result };
    } catch (error) {
      return errorReply(id, error);
    }
  }
  #connected(): Provisioner {
    if (!this.#provisioner)
      throw new ProvisioningError("approval_required", "accounts");
    return this.#provisioner;
  }
}

// Bounded framing before JSON parsing, with sequential commands/backpressure.
// Neither stdin frames nor unexpected exceptions are printed to stderr.
export async function runBridge(
  input: AsyncIterable<Uint8Array>,
  output: (line: string) => Promise<void>,
  session = new BridgeSession(),
): Promise<void> {
  let chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const raw of input) {
      const chunk = Buffer.from(raw);
      let start = 0;
      for (let index = 0; index <= chunk.length; index++) {
        if (index !== chunk.length && chunk[index] !== 10) continue;
        const part = chunk.subarray(start, index);
        length += part.length;
        if (length > MAX_FRAME_BYTES) {
          await output(
            `${JSON.stringify(errorReply(null, new ProvisioningError("invalid_input", "confirmation")))}\n`,
          );
          return;
        }
        chunks.push(part);
        if (index !== chunk.length) {
          let reply: Reply;
          try {
            reply = await session.handle(
              JSON.parse(Buffer.concat(chunks, length).toString("utf8")),
            );
          } catch {
            reply = errorReply(
              null,
              new ProvisioningError("invalid_input", "confirmation"),
            );
          }
          chunks = [];
          length = 0;
          await output(`${JSON.stringify(reply)}\n`);
          if (session.closed) return;
        }
        start = index + 1;
      }
    }
    if (length > 0)
      await output(
        `${JSON.stringify(errorReply(null, new ProvisioningError("invalid_input", "confirmation")))}\n`,
      );
  } finally {
    session.dispose();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv.length !== 3 || process.argv[2] !== "--stdio")
    process.exitCode = 2;
  else {
    // Backpressure prevents accumulating stdout or unbounded pending requests.
    runBridge(
      process.stdin,
      (line) =>
        new Promise<void>((resolve, reject) => {
          process.stdout.write(line, (error) =>
            error ? reject(error) : resolve(),
          );
        }),
    ).catch(() => {
      process.exitCode = 1;
    });
  }
}
