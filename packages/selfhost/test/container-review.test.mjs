import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertRunnerPathSeparation, containerArgs, validRunnerImage, verifyContainerRunner } from '../src/container-review.mjs';
import { openAccountServer } from '../src/account-server.mjs';

const image = `example.invalid/morons-runner@sha256:${'a'.repeat(64)}`;

test('container invocation has only bounded mounts and no host credentials, network, or privilege', () => {
  assert.equal(validRunnerImage(image), true);
  for (const bad of ['node:latest', '--privileged', `${image}\n--network=host`])
    assert.equal(validRunnerImage(bad), false);
  const args = containerArgs({ image, repository: '/tmp/source', reviewRoot: '/tmp/reviews', workerRoot: '/tmp/worker', uid: 501, gid: 20 });
  const joined = args.join(' ');
  for (const required of ['--pull=never', '--network=none', '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges=true', '--pids-limit=64', '--memory=512m',
    'source=/tmp/source,target=/source,readonly', 'source=/tmp/reviews,target=/reviews',
    'source=/tmp/worker,target=/worker,readonly']) assert.ok(joined.includes(required));
  assert.ok(!joined.includes('provider.credentials'));
  assert.ok(!joined.includes('accounts.sqlite'));
  assert.ok(!joined.includes('docker.sock'));
  assert.throws(() => containerArgs({ image, repository: '/tmp/source,consistency=delegated', reviewRoot: '/tmp/reviews' }),
    /invalid_runner_mount/);
});

test('runner rejects private data nested in source, symlink aliases, and linked worktrees', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'morons-runner-paths-'));
  const source = join(dir, 'source');
  const privateDir = join(source, 'private');
  try {
    await mkdir(join(source, '.git'), { recursive: true });
    await mkdir(privateDir);
    await assert.rejects(assertRunnerPathSeparation(source, privateDir), /runner_private_path_overlaps_source/);
    const alias = join(dir, 'private-alias');
    await symlink(privateDir, alias);
    await assert.rejects(assertRunnerPathSeparation(source, alias), /runner_private_path_overlaps_source/);
    const outside = join(dir, 'outside');
    await mkdir(outside);
    assert.deepEqual(await assertRunnerPathSeparation(source, outside),
      { source: await realpath(source), privatePath: await realpath(outside) });
    await rm(join(source, '.git'), { recursive: true });
    await writeFile(join(source, '.git'), 'gitdir: ../main/.git/worktrees/linked\n');
    await assert.rejects(assertRunnerPathSeparation(source, outside), /runner_source_must_have_embedded_git/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('actual account server rejects source and account-data overlap before Docker preflight', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'morons-runner-config-'));
  const source = join(dir, 'source');
  try {
    await mkdir(join(source, '.git'), { recursive: true });
    const args = { bootstrapToken: 'synthetic-bootstrap-token-1234567890',
      repositoryPlan: { repository: source, allowedPaths: ['README.md'], runnerImage: image } };
    await assert.rejects(openAccountServer({ ...args, dataDir: join(source, 'private-data') }),
      /runner_private_path_overlaps_source/);
    await assert.rejects(openAccountServer({ ...args, dataDir: dir }),
      /runner_private_path_overlaps_source/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CLI rejects bootstrap and provider-key files inside the mounted repository', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'morons-runner-private-files-'));
  const source = join(dir, 'source');
  try {
    await mkdir(join(source, '.git'), { recursive: true });
    const safeBootstrap = join(dir, 'bootstrap');
    const badBootstrap = join(source, 'bootstrap');
    const safeKey = join(dir, 'provider-key');
    const badKey = join(source, 'provider-key');
    for (const path of [safeBootstrap, badBootstrap])
      await writeFile(path, 'synthetic-bootstrap-token-1234567890', { mode: 0o600 });
    for (const path of [safeKey, badKey]) await writeFile(path, Buffer.alloc(32, 7), { mode: 0o600 });
    for (const [bootstrap, providerKey] of [[badBootstrap, safeKey], [safeBootstrap, badKey]]) {
      assert.throws(() => execFileSync(process.execPath, ['src/account-server.mjs'], {
        cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8',
        env: { ...process.env, MORONS_DATA_DIR: join(dir, 'data'),
          MORONS_BOOTSTRAP_TOKEN_FILE: bootstrap, MORONS_PROVIDER_KEY_FILE: providerKey,
          MORONS_REPOSITORY: source, MORONS_SOURCE_PATHS: 'README.md',
          MORONS_PROVIDER_MODEL_ID: 'mock-model', MORONS_RUNNER_IMAGE: image },
        timeout: 10_000,
      }), (error) => error.status === 1 && /runner_private_path_overlaps_source/.test(error.stderr));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('live container denies file escape, symlink escape, credential env, network, and approval writes', async (t) => {
  const runnerImage = process.env.MORONS_TEST_RUNNER_IMAGE;
  if (!runnerImage) return t.skip('set MORONS_TEST_RUNNER_IMAGE to a preloaded immutable Node 22+ and Git image');
  try { await verifyContainerRunner(runnerImage); }
  catch (error) { return t.skip(`container preflight unavailable: ${error.message}`); }
  const dir = await mkdtemp(join(tmpdir(), 'morons-container-boundary-'));
  const source = join(dir, 'source');
  const reviews = join(dir, 'reviews');
  const privateFile = join(dir, 'approval.sqlite');
  try {
    await mkdir(source);
    await mkdir(reviews);
    await writeFile(privateFile, 'synthetic-private-data');
    await symlink(privateFile, join(source, 'outside-link'));
    const script = `
      const fs = require('node:fs');
      const cp = require('node:child_process');
      const net = require('node:net');
      const canRead = (p) => { try { fs.readFileSync(p); return true; } catch { return false; } };
      const canWrite = (p) => { try { fs.writeFileSync(p, 'tampered'); return true; } catch { return false; } };
      const subprocess = cp.spawnSync('sh', ['-c', 'cat /approval.sqlite'], { encoding: 'utf8' });
      const socket = net.connect({ host: '1.1.1.1', port: 53 });
      socket.setTimeout(1500);
      socket.on('connect', () => finish(true));
      socket.on('error', () => finish(false));
      socket.on('timeout', () => finish(false));
      function finish(network) {
        socket.destroy();
        process.stdout.write(JSON.stringify({ direct: canRead('/approval.sqlite'),
          symlink: canRead('/source/outside-link'), credential: process.env.MORONS_TEST_CREDENTIAL,
          subprocess: subprocess.status === 0, network, approvalWrite: canWrite('/approval.sqlite') }));
      }
    `;
    const args = containerArgs({ image: runnerImage, repository: source, reviewRoot: reviews,
      workerRoot: new URL('../../review-runner/', import.meta.url).pathname });
    args.splice(-1, 1, '-e', script);
    const result = execFileSync('docker', args, { encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, MORONS_TEST_CREDENTIAL: 'synthetic-secret' } });
    assert.deepEqual(JSON.parse(result), { direct: false, symlink: false,
      subprocess: false, network: false, approvalWrite: false });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
