import { readFile } from 'node:fs/promises';

const packages = {
  ai: '@earendil-works/pi-ai',
  durable: '@earendil-works/pi-durable',
};

function versionParts(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value ?? '');
  return match ? match.slice(1).map(Number) : null;
}

function newer(candidate, installed) {
  const left = versionParts(candidate);
  const right = versionParts(installed);
  if (!left || !right || left[0] !== right[0]) return false;
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}

async function installedVersion(name) {
  const url = new URL(`../node_modules/${name}/package.json`, import.meta.url);
  const manifest = JSON.parse(await readFile(url, 'utf8'));
  if (manifest.name !== name || !versionParts(manifest.version)) throw new Error('invalid_installed_pi_package');
  return manifest.version;
}

async function publishedVersion(name, fetcher) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`;
  const response = await fetcher(url, { signal: AbortSignal.timeout(4000),
    headers: { accept: 'application/json' } });
  if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 65536)
    throw new Error('pi_registry_unavailable');
  const body = await response.text();
  if (body.length > 65536) throw new Error('pi_registry_response_too_large');
  const manifest = JSON.parse(body);
  if (manifest.name !== name || !versionParts(manifest.version)) throw new Error('invalid_pi_registry_response');
  return manifest.version;
}

export async function piVersionStatus({ fetcher = fetch, checkPublished = true } = {}) {
  const installed = Object.fromEntries(await Promise.all(Object.entries(packages)
    .map(async ([key, name]) => [key, await installedVersion(name)])));
  let latestPublished = null;
  if (checkPublished) {
    try {
      latestPublished = Object.fromEntries(await Promise.all(Object.entries(packages)
        .map(async ([key, name]) => [key, await publishedVersion(name, fetcher)])));
    } catch {}
  }
  const comparable = latestPublished && Object.keys(packages).every((key) =>
    versionParts(latestPublished[key])[0] === versionParts(installed[key])[0]);
  const candidate = comparable && Object.keys(packages)
    .some((key) => newer(latestPublished[key], installed[key]));
  return {
    installed,
    latestPublished,
    status: comparable ? candidate ? 'candidate' : 'current' : 'unknown',
    compatibility: 'unverified',
    updateSupported: false,
  };
}
