import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm, symlink, writeFile, mkdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { trustedCheckPlan } from '../../review-runner/src/check-policy.mjs';

const runnerDirectory = fileURLToPath(new URL('../../review-runner/', import.meta.url));
const MAX_OUTPUT = 512 * 1024;

export function validRunnerImage(image) {
  return typeof image === 'string' && image.length <= 255 &&
    /^(?!-)[^\s,]+@sha256:[0-9a-f]{64}$/.test(image);
}

export async function assertRunnerPathSeparation(repository, privateRoot) {
  const [source, privatePath] = await Promise.all([realpath(repository), realpath(privateRoot)]);


  const gitDir = await lstat(join(source, '.git')).catch(() => null);
  if (!gitDir?.isDirectory()) throw new Error('runner_source_must_have_embedded_git');
  if (source === privatePath || source.startsWith(`${privatePath}${sep}`) ||
      privatePath.startsWith(`${source}${sep}`)) throw new Error('runner_private_path_overlaps_source');
  return { source, privatePath };
}

function mountPath(path) {
  if (!path.startsWith('/') || /[,\r\n\0]/.test(path)) throw new Error('invalid_runner_mount');
  return path;
}

export function containerArgs({ image, repository, reviewRoot, workerRoot = runnerDirectory,
  uid = process.getuid?.(), gid = process.getgid?.() }) {
  if (!validRunnerImage(image) || !Number.isInteger(uid) || !Number.isInteger(gid))
    throw new Error('invalid_runner_configuration');
  return [
    'run', '--pull=never', '--rm', '--interactive', '--network=none', '--read-only',
    '--cap-drop=ALL', '--security-opt=no-new-privileges=true', '--pids-limit=64',
    '--memory=512m', '--cpus=1', '--ipc=none', '--user', `${uid}:${gid}`,
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=32m',
    '--env', 'PATH=/usr/local/bin:/usr/bin:/bin', '--env', 'HOME=/tmp',
    '--env', 'LANG=C', '--env', 'GIT_CONFIG_NOSYSTEM=1',
    '--env', 'GIT_CONFIG_GLOBAL=/dev/null', '--env', 'GIT_TERMINAL_PROMPT=0',
    '--mount', `type=bind,source=${mountPath(repository)},target=/source,readonly`,
    '--mount', `type=bind,source=${mountPath(reviewRoot)},target=/reviews`,
    '--mount', `type=bind,source=${mountPath(workerRoot)},target=/worker,readonly`,
    '--workdir', '/worker', '--entrypoint', 'node', image, '/worker/src/worker.mjs',
  ];
}

function workspaceName(workspaceRoot) {
  return `morons-${createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 24)}`;
}

function workspaceFingerprint({ image, repository, reviewRoot, workspaceRoot, workerRoot }) {
  return createHash('sha256').update(JSON.stringify({ policy: 1, image, repository, reviewRoot,
    workspaceRoot, workerRoot })).digest('hex');
}

export function workspaceCreateArgs({ image, repository, reviewRoot, workspaceRoot,
  workerRoot = runnerDirectory, uid = process.getuid?.(), gid = process.getgid?.() }) {
  if (!validRunnerImage(image) || !Number.isInteger(uid) || !Number.isInteger(gid))
    throw new Error('invalid_runner_configuration');
  const configuration = { image, repository, reviewRoot, workspaceRoot, workerRoot };
  return [
    'create', '--pull=never', '--name', workspaceName(workspaceRoot),
    '--label', `morons.workspace.fingerprint=${workspaceFingerprint(configuration)}`,
    '--network=none', '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges=true', '--pids-limit=64', '--memory=512m',
    '--cpus=1', '--ipc=none', '--user', `${uid}:${gid}`,
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=32m',
    '--env', 'PATH=/usr/local/bin:/usr/bin:/bin', '--env', 'HOME=/home/morons',
    '--env', 'LANG=C', '--env', 'GIT_CONFIG_NOSYSTEM=1',
    '--env', 'GIT_CONFIG_GLOBAL=/dev/null', '--env', 'GIT_TERMINAL_PROMPT=0',
    '--mount', `type=bind,source=${mountPath(repository)},target=/source,readonly`,
    '--mount', `type=bind,source=${mountPath(reviewRoot)},target=/reviews`,
    '--mount', `type=bind,source=${mountPath(workspaceRoot)},target=/home/morons`,
    '--mount', `type=bind,source=${mountPath(workerRoot)},target=/worker,readonly`,
    '--workdir', '/worker', '--entrypoint', 'sleep', image, 'infinity',
  ];
}

function docker(args, input = '', timeout = 180_000) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['--context', 'desktop-linux', ...args], { stdio: ['pipe', 'pipe', 'pipe'],


      env: { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' },
      windowsHide: true });
    let output = '', error = '';
    let settled = false;
    const fail = (reason) => { if (!settled) { settled = true; child.kill('SIGKILL'); reject(new Error(reason)); } };
    const timer = setTimeout(() => fail('container_runner_timeout'), timeout);
    child.on('error', () => fail('container_runner_unavailable'));
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (Buffer.byteLength(output) > MAX_OUTPUT) fail('container_result_too_large');
    });
    child.stderr.on('data', (chunk) => {
      error += chunk;
      if (Buffer.byteLength(error) > 4096) fail('container_error_too_large');
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ code, output, error });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function inspectWorkspace(configuration) {
  const name = workspaceName(configuration.workspaceRoot);
  const result = await docker(['container', 'inspect', name], '', 10_000);
  if (result.code !== 0) return null;
  let details;
  try { details = JSON.parse(result.output)?.[0]; } catch { throw new Error('workspace_inspect_failed'); }
  const mounts = details?.Mounts ?? [];
  const expected = [
    [configuration.repository, '/source', false],
    [configuration.reviewRoot, '/reviews', true],
    [configuration.workspaceRoot, '/home/morons', true],
    [configuration.workerRoot, '/worker', false],
  ];
  if (details?.Config?.Labels?.['morons.workspace.fingerprint'] !== workspaceFingerprint(configuration) ||
      details?.Config?.Image !== configuration.image ||
      details?.HostConfig?.NetworkMode !== 'none' ||
      details?.HostConfig?.ReadonlyRootfs !== true ||
      details?.HostConfig?.Privileged !== false ||
      !details?.HostConfig?.CapDrop?.includes('ALL') ||
      !details?.HostConfig?.SecurityOpt?.includes('no-new-privileges:true') ||
      details?.HostConfig?.PidsLimit !== 64 ||
      details?.HostConfig?.Memory !== 512 * 1024 * 1024 ||
      details?.HostConfig?.NanoCpus !== 1_000_000_000 ||
      details?.HostConfig?.IpcMode !== 'none' ||
      details?.Config?.User !== `${process.getuid?.()}:${process.getgid?.()}` ||
      mounts.length !== expected.length || expected.some(([source, destination, rw]) =>
        !mounts.some((mount) => mount.Type === 'bind' && mount.Source === source &&
          mount.Destination === destination && mount.RW === rw)))
    throw new Error('workspace_configuration_mismatch');
  return details;
}

const workspaceQueues = new Map();
const poisonedWorkspaces = new Set();

function serializeWorkspace(name, action) {
  const prior = workspaceQueues.get(name) ?? Promise.resolve();
  const current = prior.catch(() => {}).then(action);
  workspaceQueues.set(name, current);
  current.finally(() => { if (workspaceQueues.get(name) === current) workspaceQueues.delete(name); }).catch(() => {});
  return current;
}

async function workspaceConfiguration(plan) {
  if (!plan.reviewRoot || !plan.workspaceRoot) throw new Error('persistent_workspace_root_required');
  for (const path of [plan.reviewRoot, plan.workspaceRoot]) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid()))
      throw new Error('private_workspace_directory_required');
  }
  const { source: repository, privatePath: reviewRoot } =
    await assertRunnerPathSeparation(plan.repository, plan.reviewRoot);
  const workspaceRoot = await realpath(plan.workspaceRoot);
  await assertRunnerPathSeparation(plan.repository, workspaceRoot);
  if (workspaceRoot === reviewRoot || workspaceRoot.startsWith(`${reviewRoot}${sep}`) ||
      reviewRoot.startsWith(`${workspaceRoot}${sep}`)) throw new Error('workspace_review_path_overlap');
  return { image: plan.runnerImage, repository, reviewRoot, workspaceRoot,
    workerRoot: await realpath(runnerDirectory) };
}

async function provisionWorkspace(configuration) {
  let details = await inspectWorkspace(configuration);
  if (!details) {
    const created = await docker(workspaceCreateArgs(configuration), '', 30_000);
    if (created.code !== 0) {
      details = await inspectWorkspace(configuration);
      if (!details) throw new Error('workspace_create_failed');
    } else details = await inspectWorkspace(configuration);
  }
  if (!details?.State?.Running) {
    const started = await docker(['start', workspaceName(configuration.workspaceRoot)], '', 30_000);
    if (started.code !== 0) throw new Error('workspace_start_failed');
  }
}

export async function openDockerWorkspaceProvider(plan) {
  const configuration = await workspaceConfiguration(plan);
  const name = workspaceName(configuration.workspaceRoot);
  return {
    workspacePath: configuration.workspaceRoot,
    provision: () => serializeWorkspace(name, () => provisionWorkspace(configuration)),
    execute: (input) => serializeWorkspace(name, async () => {
      if (poisonedWorkspaces.has(name)) throw new Error('workspace_requires_manual_recovery');
      await provisionWorkspace(configuration);
      try {
        return await docker(['exec', '--interactive', '--workdir', '/worker',
          name, 'node', '/worker/src/worker.mjs'], input, 360_000);
      } catch (error) {
        poisonedWorkspaces.add(name);
        const stopped = await docker(['stop', '--time', '0', name], '', 20_000).catch(() => null);
        const details = await inspectWorkspace(configuration).catch(() => null);
        if (stopped?.code === 0 && details && !details.State?.Running)
          poisonedWorkspaces.delete(name);
        throw error;
      }
    }),
    stop: () => serializeWorkspace(name, async () => {
      const details = await inspectWorkspace(configuration);
      if (details?.State?.Running) {
        const stopped = await docker(['stop', '--time', '10', name], '', 20_000);
        if (stopped.code !== 0) throw new Error('workspace_stop_failed');
      }
    }),
  };
}

export async function stopContainerWorkspace(plan) {
  if (!plan?.runnerImage || !plan.workspaceRoot) return;
  await (await openDockerWorkspaceProvider(plan)).stop();
}


export async function verifyContainerRunner(image) {
  if (!validRunnerImage(image)) throw new Error('runner_image_digest_required');
  const daemon = await docker(['info', '--format', '{{.ServerVersion}}'], '', 10_000);
  if (daemon.code !== 0) throw new Error('container_engine_not_running');
  const inspect = await docker(['image', 'inspect', image, '--format', '{{.Id}}'], '', 10_000);
  if (inspect.code !== 0) throw new Error('runner_image_not_present');
  for (const [entrypoint, expected] of [['node', /^v(2[2-9]|[3-9]\d)\./], ['git', /^git version /]]) {
    const check = await docker(['run', '--pull=never', '--rm', '--network=none', '--read-only',
      '--cap-drop=ALL', '--security-opt=no-new-privileges=true', '--entrypoint', entrypoint,
      image, '--version'], '', 15_000);
    if (check.code !== 0 || !expected.test(check.output)) throw new Error('runner_image_missing_node_or_git');
  }


  const probeRoot = await mkdtemp(join(tmpdir(), 'morons-runner-probe-'));
  const source = join(probeRoot, 'source');
  const reviews = join(probeRoot, 'reviews');
  try {
    await mkdir(source);
    await mkdir(reviews);
    const outside = join(probeRoot, 'approval.sqlite');
    await writeFile(outside, 'synthetic-private-data');
    await symlink(outside, join(source, 'outside-link'));
    const script = `
      const fs = require('node:fs');
      const cp = require('node:child_process');
      const net = require('node:net');
      const read = (p) => { try { fs.readFileSync(p); return true; } catch { return false; } };
      const write = (p) => { try { fs.writeFileSync(p, 'tampered'); return true; } catch { return false; } };
      const subprocess = cp.spawnSync('sh', ['-c', 'cat /approval.sqlite'], { encoding: 'utf8' });
      const socket = net.connect({ host: '1.1.1.1', port: 53 });
      socket.setTimeout(1500);
      socket.on('connect', () => finish(true));
      socket.on('error', () => finish(false));
      socket.on('timeout', () => finish(false));
      function finish(network) {
        socket.destroy();
        process.stdout.write(JSON.stringify({ direct: read('/approval.sqlite'),
          symlink: read('/source/outside-link'), credential: !!process.env.MORONS_TEST_CREDENTIAL,
          subprocess: subprocess.status === 0, network, approvalWrite: write('/approval.sqlite') }));
      }
    `;
    const args = containerArgs({ image, repository: await realpath(source),
      reviewRoot: await realpath(reviews), workerRoot: await realpath(runnerDirectory) });
    args.splice(-1, 1, '-e', script);
    const probe = await docker(args, '', 15_000);
    let answer;
    try { answer = JSON.parse(probe.output); } catch { throw new Error('container_boundary_probe_failed'); }
    if (probe.code !== 0 || Object.values(answer).some(Boolean) || Object.keys(answer).length !== 6)
      throw new Error('container_boundary_probe_failed');
  } finally { await rm(probeRoot, { recursive: true, force: true }); }
}

export async function runContainerReviewOperation(plan, operation) {
  if (!validRunnerImage(plan.runnerImage)) throw new Error('runner_image_digest_required');
  trustedCheckPlan(plan.checkProfile, plan.allowedPaths);
  const provider = await openDockerWorkspaceProvider(plan);
  const input = JSON.stringify({ plan: { repository: '/source', reviewRoot: '/reviews',
    allowedPaths: plan.allowedPaths, checkProfile: plan.checkProfile, isolatedClone: true }, ...operation });
  if (Buffer.byteLength(input) > 300_000) throw new Error('review_request_too_large');
  const result = await provider.execute(input);
  let response;
  try { response = JSON.parse(result.output); } catch { throw new Error('container_review_failed'); }
  if (result.code !== 0 || response?.ok !== true) throw new Error('container_review_failed');
  return response.result;
}
