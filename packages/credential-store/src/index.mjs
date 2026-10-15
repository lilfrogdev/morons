import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

const AAD = Buffer.from("morons.pi-credentials.v1", "utf8");
const FORMAT = "morons.pi-credentials.v1";

function assertSignal(options) { options?.signal?.throwIfAborted(); }
function assertProviderId(id) {
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(id)) throw new Error("invalid_provider_id");
}
function clone(value) { return value === undefined ? undefined : structuredClone(value); }
function validateCredential(value) {
  if (!value || typeof value !== "object" || !["api_key", "oauth"].includes(value.type)) throw new Error("invalid_credential");
  if (value.type === "oauth" && (typeof value.access !== "string" || typeof value.refresh !== "string" || !Number.isFinite(value.expires)))
    throw new Error("invalid_credential");
  JSON.stringify(value);
}
function encrypt(key, credentials) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(credentials), "utf8"), cipher.final()]);
  return JSON.stringify({ format: FORMAT, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: encrypted.toString("base64") });
}
function decrypt(key, data) {
  const envelope = JSON.parse(data);
  if (envelope.format !== FORMAT) throw new Error("unsupported_credential_format");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const records = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8"));
  if (!records || Array.isArray(records) || typeof records !== "object") throw new Error("invalid_credential_file");
  for (const [id, credential] of Object.entries(records)) { assertProviderId(id); validateCredential(credential); }
  return records;
}
async function assertPrivateRegularFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error("insecure_credential_file");
}
async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error("insecure_credential_directory");
}







export async function openEncryptedCredentialStore({ filePath, key }) {
  if (!isAbsolute(filePath ?? "")) throw new Error("absolute_file_path_required");
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("32_byte_key_required");
  const localKey = Buffer.from(key);
  const dir = dirname(filePath);
  await ensurePrivateDirectory(dir);
  const lockPath = `${filePath}.lock`;
  let lock;
  try {
    lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await lock.writeFile(String(process.pid));
    await lock.sync();
  } catch (error) {
    localKey.fill(0);
    if (lock) { await lock.close(); await rm(lockPath, { force: true }); }
    if (error.code === "EEXIST") throw new Error("credential_store_owned_by_another_process");
    throw error;
  }
  let closed = false;
  let tail = Promise.resolve();
  let counter = 0;
  async function readRecords() {
    try { await assertPrivateRegularFile(filePath); }
    catch (error) { if (error.code === "ENOENT") return {}; throw error; }
    return decrypt(localKey, await readFile(filePath, "utf8"));
  }
  async function persist(records) {
    const tempPath = join(dir, `.${basename(filePath)}.${process.pid}.${counter++}.${randomBytes(8).toString("hex")}.tmp`);
    let handle;
    try {
      handle = await open(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(encrypt(localKey, records), "utf8");
      await handle.sync();
      await handle.close(); handle = undefined;
      await rename(tempPath, filePath);
      const dirHandle = await open(dir, constants.O_RDONLY);
      try { await dirHandle.sync(); } finally { await dirHandle.close(); }
    } finally { if (handle) await handle.close(); await rm(tempPath, { force: true }); }
  }
  function queued(action, options) {
    if (closed) return Promise.reject(new Error("credential_store_closed"));
    const next = tail.catch(() => {}).then(async () => { assertSignal(options); if (closed) throw new Error("credential_store_closed"); return action(); });
    tail = next.catch(() => {});
    return next;
  }
  return {
    read(providerId, options) {
      assertProviderId(providerId);
      return queued(async () => clone((await readRecords())[providerId]), options);
    },
    list(options) {
      return queued(async () => Object.entries(await readRecords()).map(([providerId, credential]) => ({ providerId, type: credential.type })), options);
    },
    modify(providerId, fn, options) {
      assertProviderId(providerId);
      if (typeof fn !== "function") return Promise.reject(new Error("modify_callback_required"));
      return queued(async () => {
        const records = await readRecords();
        const current = clone(records[providerId]);
        const updated = await fn(current);
        if (updated !== undefined) { validateCredential(updated); records[providerId] = clone(updated); await persist(records); }
        return clone(records[providerId]);
      }, options);
    },
    delete(providerId, options) {
      assertProviderId(providerId);
      return queued(async () => { const records = await readRecords(); if (providerId in records) { delete records[providerId]; await persist(records); } }, options);
    },
    async close() {
      if (closed) return;
      closed = true;
      try { await tail; } finally { localKey.fill(0); await lock.close(); await rm(lockPath, { force: true }); }
    },
  };
}
