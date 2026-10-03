import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import type { Identity, ProtectedSessionIO } from "./index.js";
import { AuthError } from "./index.js";
const SERVICE = "morons://local/chatgpt-session/v1";
export interface StorageIntent {
  action: "read" | "write";
  service: typeof SERVICE;
  slot: string;
  identity: Identity;
  sha256?: string;
}
export type StorageApproval = (
  intent: StorageIntent,
  signal: AbortSignal,
) => Promise<void>;
export type BrokerRun = (input: string, signal: AbortSignal) => Promise<string>;
// Private pipe, fixed executable path chosen by the packaged service, empty
// environment, no shell or credential arguments. Never fall back to `security`.
export function nativeBrokerRun(executable: string): BrokerRun {
  if (!isAbsolute(executable)) throw new AuthError("invalid_attempt");
  return async (input, signal) => {
    if (Buffer.byteLength(input) > 66560 || signal.aborted)
      throw new AuthError("reauth_required");
    return new Promise<string>((resolve, reject) => {
      const child = spawn(executable, [], {
        shell: false,
        env: {},
        stdio: ["pipe", "pipe", "ignore"],
        signal,
      });
      const parts: Buffer[] = [];
      let bytes = 0;
      let failed = false;
      const fail = () => {
        failed = true;
        child.kill();
        reject(new AuthError("reauth_required"));
      };
      child.on("error", fail);
      child.stdin.on("error", fail);
      child.stdout.on("data", (part: Buffer) => {
        bytes += part.length;
        if (bytes > 66560) {
          part.fill(0);
          fail();
        } else parts.push(part);
      });
      child.once("close", (code) => {
        if (!failed && code === 0 && !signal.aborted) {
          const encoded = Buffer.concat(parts);
          try {
            resolve(encoded.toString("utf8"));
          } finally {
            encoded.fill(0);
          }
        } else reject(new AuthError("reauth_required"));
        for (const part of parts) part.fill(0);
      });
      child.stdin.end(input);
    });
  };
}
async function bounded<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new AuthError("cancelled"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
async function sha256(value: string) {
  return Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  ).toString("hex");
}
// All callers must share one daemon owner. Approval is mandatory for EACH
// read/write, including refresh markers/replacement writes; there is no default
// permission or unattended credential read on construction/import.
export function keychainSessionIO(
  hostId: string,
  approve: StorageApproval,
  run: BrokerRun,
): ProtectedSessionIO {
  if (
    !/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      hostId,
    )
  )
    throw new AuthError("invalid_attempt");
  const exchange = async (
    action: "read" | "write",
    identity: Identity,
    payload?: string,
    callerSignal?: AbortSignal,
  ) => {
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000);
    try {
      signal.throwIfAborted();
      if (
        identity.issuer !== "https://auth.openai.com" ||
        !/^[A-Za-z0-9_-]{1,256}$/.test(identity.clientId) ||
        identity.clientId === "dynamic_agent_client" ||
        !/^[^\x00-\x20\x7f]{1,16384}$/.test(identity.subject) ||
        (payload !== undefined && Buffer.byteLength(payload) > 65536)
      )
        throw new AuthError("validation_failed");
      const frozen = Object.freeze({ ...identity });
      const slot = await sha256(
        JSON.stringify([
          hostId,
          frozen.issuer,
          frozen.subject,
          frozen.clientId,
        ]),
      );
      await bounded(
        approve(
          {
            action,
            service: SERVICE,
            slot,
            identity: frozen,
            ...(payload !== undefined ? { sha256: await sha256(payload) } : {}),
          },
          signal,
        ),
        signal,
      );
      signal.throwIfAborted();
      const response = JSON.parse(
        await bounded(
          run(
            JSON.stringify({
              version: 1,
              action,
              slot,
              ...(payload !== undefined ? { payload } : {}),
            }),
            signal,
          ),
          signal,
        ),
      );
      signal.throwIfAborted();
      if (
        action === "write" &&
        response.status === "stored" &&
        Object.keys(response).join(",") === "status"
      )
        return undefined;
      if (
        action === "read" &&
        response.status === "missing" &&
        Object.keys(response).join(",") === "status"
      )
        return undefined;
      if (
        action === "read" &&
        response.status === "found" &&
        Object.keys(response).sort().join(",") === "payload,status" &&
        typeof response.payload === "string" &&
        Buffer.byteLength(response.payload) <= 65536
      )
        return response.payload as string;
      throw new AuthError("reauth_required");
    } catch {
      throw new AuthError("reauth_required");
    }
  };
  return {
    read: (identity, signal) => exchange("read", identity, undefined, signal),
    write: async (identity, payload, signal) => {
      await exchange("write", identity, payload, signal);
    },
  };
}
