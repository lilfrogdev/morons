import { hkdfSync, randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openEncryptedCredentialStore } from '@morons/credential-store';
import { createPiProviderAuth } from '@morons/provider-auth/src/pi-models.mjs';

/** Real Pi provider remains opt-in. The caller supplies a 32-byte unlock key outside argv/logs. */
export async function openProviderRuntime({ directory, accountId, masterKey }) {
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) throw new Error('provider_unlock_key_required');
  const derived = Buffer.from(hkdfSync('sha256', masterKey, Buffer.from(accountId), Buffer.from('morons-provider-v1'), 32));
  let credentials;
  try {
    credentials = await openEncryptedCredentialStore({ filePath: join(directory, 'provider.credentials'), key: derived });
  } finally { derived.fill(0); }
  try {
    const devicePath = join(directory, 'provider-device.id');
    let deviceId;
    try {
      const info = await lstat(devicePath);
      if (!info.isFile() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()))
        throw new Error('insecure_provider_device_id');
      deviceId = (await readFile(devicePath, 'utf8')).trim();
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      deviceId = randomUUID();
      await writeFile(devicePath, `${deviceId}\n`, { flag: 'wx', mode: 0o600 });
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deviceId))
      throw new Error('invalid_provider_device_id');
    const { models, auth } = createPiProviderAuth({ credentials, getDeviceId: () => deviceId });
    return { models, auth, close: () => credentials.close() };
  } catch (error) { await credentials.close(); throw error; }
}
