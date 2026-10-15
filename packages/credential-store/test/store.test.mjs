import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openEncryptedCredentialStore } from "../src/index.mjs";

async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), "morons-credentials-"));
  const filePath = join(dir, "credentials.enc");
  const key = randomBytes(32);
  try { await fn({ filePath, key, dir }); }
  finally { await rm(dir, { recursive: true, force: true }); key.fill(0); }
}
const credential = (suffix) => ({ type: "oauth", access: `access-${suffix}`, refresh: `refresh-${suffix}`, expires: 42 });

test("encrypted persistence, metadata-only list, and owner-private permissions", () => fixture(async ({ filePath, key, dir }) => {
  const store = await openEncryptedCredentialStore({ filePath, key });
  await store.modify("openai", async () => credential("one"));
  assert.deepEqual(await store.list(), [{ providerId: "openai", type: "oauth" }]);
  const onDisk = await readFile(filePath, "utf8");
  assert.doesNotMatch(onDisk, /access-one|refresh-one/);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  await store.close();
  const restored = await openEncryptedCredentialStore({ filePath, key });
  assert.deepEqual(await restored.read("openai"), credential("one"));
  await restored.delete("openai");
  assert.deepEqual(await restored.list(), []);
  await restored.close();
}));

test("serializes refresh-like modifications and keeps current value on undefined", () => fixture(async ({ filePath, key }) => {
  const store = await openEncryptedCredentialStore({ filePath, key });
  await store.modify("openai", async () => credential("old"));
  const calls = [];
  await Promise.all(Array.from({ length: 5 }, (_, i) => store.modify("openai", async (current) => {
    calls.push(current.access);
    await new Promise((resolve) => setTimeout(resolve, 2));
    return credential(i);
  })));
  assert.equal(new Set(calls).size, 5);
  assert.equal((await store.modify("openai", async () => undefined)).access, "access-4");
  await store.close();
}));

test("enforces one owner and rejects wrong key without corrupting ciphertext", () => fixture(async ({ filePath, key }) => {
  const store = await openEncryptedCredentialStore({ filePath, key });
  await store.modify("openai", async () => credential("secret"));
  await assert.rejects(() => openEncryptedCredentialStore({ filePath, key }), /owned_by_another_process/);
  await store.close();
  const wrong = await openEncryptedCredentialStore({ filePath, key: randomBytes(32) });
  await assert.rejects(() => wrong.read("openai"));
  await wrong.close();
  const correct = await openEncryptedCredentialStore({ filePath, key });
  assert.equal((await correct.read("openai")).access, "access-secret");
  await correct.close();
}));

test("rejects symlink credential file and invalid key", () => fixture(async ({ filePath, key, dir }) => {
  await assert.rejects(() => openEncryptedCredentialStore({ filePath, key: Buffer.alloc(4) }), /32_byte_key_required/);
  await symlink(join(dir, "target"), filePath);
  const store = await openEncryptedCredentialStore({ filePath, key });
  await assert.rejects(() => store.read("openai"), /insecure_credential_file/);
  await store.close();
}));

test("a failed or aborted modify preserves the prior credential", () => fixture(async ({ filePath, key }) => {
  const store = await openEncryptedCredentialStore({ filePath, key });
  await store.modify("openai", async () => credential("prior"));
  await assert.rejects(() => store.modify("openai", async () => { throw new Error("refresh failed"); }), /refresh failed/);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(() => store.modify("openai", async () => credential("wrong"), { signal: aborted.signal }));
  assert.deepEqual(await store.read("openai"), credential("prior"));
  await store.close();
}));

test("rejects an existing credential file with broad permissions", () => fixture(async ({ filePath, key }) => {
  const store = await openEncryptedCredentialStore({ filePath, key });
  await store.modify("openai", async () => credential("prior"));
  await chmod(filePath, 0o644);
  await assert.rejects(() => store.read("openai"), /insecure_credential_file/);
  await store.close();
}));
