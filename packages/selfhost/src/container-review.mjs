import { execFile, spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, realpath, rm, symlink, writeFile, mkdir, lstat, chmod, readFile, rename, cp, readdir, readlink, unlink, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { trustedCheckPlan } from '../../review-runner/src/check-policy.mjs';

const runnerDirectory = fileURLToPath(new URL('../../review-runner/', import.meta.url));
const MAX_OUTPUT = 512 * 1024;
const workerFiles = ['package.json', 'src/check-policy.mjs', 'src/index.mjs', 'src/worker.mjs'];
const hostExec = promisify(execFile);
const knownWorkspaces = new Set();

async function directoryEntries(roots) {
  const entries = {};
  async function visit(path, relative) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      entries[relative] = `link:${await readlink(path)}`;
    } else if (info.isFile()) {
      const digest = createHash('sha256');
      for await (const chunk of createReadStream(path)) digest.update(chunk);
      entries[relative] = `file:${digest.digest('hex')}`;
    } else if (info.isDirectory()) {
      entries[relative] = 'directory';
      for (const name of (await readdir(path)).sort()) await visit(join(path, name), `${relative}/${name}`);
    } else throw new Error('unsupported_runtime_file');
  }
  for (const [index, root] of roots.entries()) await visit(root, String(index));
  return entries;
}

function entriesDigest(entries) {
  return createHash('sha256').update(JSON.stringify(Object.entries(entries).sort())).digest('hex');
}

async function hostDirectoryDigest(roots) {
  return entriesDigest(await directoryEntries(roots));
}

function hostRoots(configuration) {
  return [configuration.hostReviewRoot, configuration.hostWorkspaceRoot];
}

async function atomicFile(path, data) {
  const temp = join(dirname(path), `.morons-write-${randomUUID()}`);
  await writeFile(temp, data, { mode: 0o600, flag: 'wx' });
  await rename(temp, path);
}

async function checkpointTree(sourceRoot, destinationRoot) {
  const tempRoot = join(dirname(destinationRoot),
    `.morons-checkpoint-${createHash('sha256').update(destinationRoot).digest('hex').slice(0, 16)}`);
  await mkdir(tempRoot, { mode: 0o700 }).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const tempInfo = await lstat(tempRoot);
  if (!tempInfo.isDirectory() || tempInfo.isSymbolicLink() || (tempInfo.mode & 0o077) !== 0 ||
      (process.getuid && tempInfo.uid !== process.getuid()))
    throw new Error('private_checkpoint_directory_required');
  async function visit(source, destination) {
    const sourceNames = new Set(await readdir(source));
    for (const name of await readdir(destination)) {
      if (!sourceNames.has(name))
        await rename(join(destination, name), join(tempRoot, `removed-${randomUUID()}`));
    }
    for (const name of [...sourceNames].sort()) {
      const from = join(source, name), to = join(destination, name);
      const info = await lstat(from);
      const targetBefore = await lstat(to).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (targetBefore && ((info.isDirectory() && !targetBefore.isDirectory()) ||
          (!info.isDirectory() && targetBefore.isDirectory())))
        await rename(to, join(tempRoot, `replaced-${randomUUID()}`));
      if (info.isDirectory()) {
        await mkdir(to, { mode: 0o700 }).catch((error) => {
          if (error.code !== 'EEXIST') throw error;
        });
        const target = await lstat(to);
        if (!target.isDirectory() || target.isSymbolicLink())
          throw new Error('runtime_checkpoint_invalid');
        await visit(from, to);
      } else if (info.isFile() || info.isSymbolicLink()) {
        const temp = join(tempRoot, `entry-${randomUUID()}`);
        if (info.isFile()) await copyFile(from, temp);
        else await symlink(await readlink(from), temp);
        await rename(temp, to);
      } else throw new Error('unsupported_runtime_file');
    }
  }
  await visit(sourceRoot, destinationRoot);
}

function runtimeMountPaths(reviewRoot, workspaceRoot, root) {
  const key = createHash('sha256').update(reviewRoot).update('\0').update(workspaceRoot).digest('hex');
  const directory = join(root, `mount-${key}`);
  return { directory, reviewRoot: join(directory, 'reviews'), workspaceRoot: join(directory, 'home') };
}

async function prepareRuntimeMounts(configuration) {
  const { directory, reviewRoot, workspaceRoot } = configuration.runtime;
  const existing = await lstat(directory).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!existing) {
    const build = await mkdtemp(join(await privateRuntimeRoot(), 'mount-build-'));
    await chmod(build, 0o700);
    await cp(configuration.hostReviewRoot, join(build, 'reviews'), { recursive: true });
    await cp(configuration.hostWorkspaceRoot, join(build, 'home'), { recursive: true });
    await writeFile(join(build, '.host-digest'), await hostDirectoryDigest(hostRoots(configuration)),
      { mode: 0o600, flag: 'wx' });
    await rename(build, directory).catch((error) => {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
    });
  }
  for (const path of [directory, reviewRoot, workspaceRoot]) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid()))
      throw new Error('private_runtime_directory_required');
  }
  const saved = await readFile(join(directory, '.host-digest'), 'utf8');
  if (await lstat(join(directory, '.checkpoint-journal')).catch(() => null)) {
    await checkpointRuntimeMounts(configuration);
  } else if (saved !== await hostDirectoryDigest(hostRoots(configuration)))
    throw new Error('runtime_host_diverged');
}

async function checkpointRuntimeMounts(configuration) {
  const marker = join(configuration.runtime.directory, '.host-digest');
  const journalPath = join(configuration.runtime.directory, '.checkpoint-journal');
  const current = await directoryEntries(hostRoots(configuration));
  let journal;
  const pending = await readFile(journalPath, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (pending) {
    try { journal = JSON.parse(pending); } catch { throw new Error('runtime_checkpoint_invalid'); }
  } else {
    if ((await readFile(marker, 'utf8')) !== entriesDigest(current))
      throw new Error('runtime_host_diverged');
    const runtimeEntries = await directoryEntries([configuration.runtime.reviewRoot,
      configuration.runtime.workspaceRoot]);
    journal = { pre: current, post: runtimeEntries };
    await atomicFile(journalPath, JSON.stringify(journal));
  }
  for (const [path, value] of Object.entries(current)) {
    if (value !== journal.pre?.[path] && value !== journal.post?.[path])
      throw new Error('runtime_host_diverged');
  }
  if (Object.keys(journal.pre ?? {}).some((path) => !(path in current) && path in journal.post &&
      journal.pre[path].split(':', 1)[0] === journal.post[path].split(':', 1)[0]))
    throw new Error('runtime_host_diverged');
  await checkpointTree(configuration.runtime.reviewRoot, configuration.hostReviewRoot);
  await checkpointTree(configuration.runtime.workspaceRoot, configuration.hostWorkspaceRoot);
  const after = await directoryEntries(hostRoots(configuration));
  if (entriesDigest(after) !== entriesDigest(journal.post))
    throw new Error('runtime_checkpoint_invalid');
  await atomicFile(marker, entriesDigest(after));
  await unlink(journalPath);
}

async function privateRuntimeRoot() {
  const root = join('/tmp', `morons-runner-${process.getuid?.() ?? 'local'}`);
  await mkdir(root, { mode: 0o700 }).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())) throw new Error('private_runtime_directory_required');
  return realpath(root);
}

async function trustedWorkerStage() {
  const root = await privateRuntimeRoot();
  const originals = await Promise.all(workerFiles.map((path) => readFile(join(runnerDirectory, path))));
  const digest = createHash('sha256');
  for (let index = 0; index < workerFiles.length; index++)
    digest.update(workerFiles[index]).update(originals[index]);
  const stage = join(root, `worker-${digest.digest('hex')}`);
  const existing = await lstat(stage).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!existing) {
    const build = await mkdtemp(join(root, 'worker-build-'));
    await chmod(build, 0o700);
    await mkdir(join(build, 'src'), { mode: 0o700 });
    for (let index = 0; index < workerFiles.length; index++)
      await writeFile(join(build, workerFiles[index]), originals[index], { mode: 0o400, flag: 'wx' });
    await rename(build, stage).catch((error) => {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
    });
  }
  const info = await lstat(stage);
  const sourceInfo = await lstat(join(stage, 'src'));
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid()) || !sourceInfo.isDirectory() ||
      sourceInfo.isSymbolicLink() || (sourceInfo.mode & 0o077) !== 0)
    throw new Error('trusted_worker_stage_invalid');
  for (let index = 0; index < workerFiles.length; index++) {
    const path = join(stage, workerFiles[index]);
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || (process.getuid && entry.uid !== process.getuid()) ||
        !(await readFile(path)).equals(originals[index])) throw new Error('trusted_worker_stage_invalid');
  }
  return stage;
}

async function hostGit(args, cwd) {
  try {
    const result = await hostExec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
      cwd, timeout: 120_000, maxBuffer: 64 * 1024,
      env: { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', HOME: '/tmp',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
        GIT_LFS_SKIP_SMUDGE: '1' },
    });
    return result.stdout.trim();
  } catch { throw new Error('runner_source_stage_failed'); }
}

async function committedSourceStage(repository, workspaceRoot, baseRevision = null) {
  const root = await privateRuntimeRoot();
  const revision = await hostGit(['rev-parse', 'HEAD'], repository);
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('runner_source_stage_failed');
  if (baseRevision && !/^[0-9a-f]{40}$/.test(baseRevision)) throw new Error('runner_source_stage_failed');
  if (baseRevision) await hostGit(['cat-file', '-e', `${baseRevision}^{commit}`], repository);
  const key = createHash('sha256').update(repository).update(workspaceRoot).update(revision)
    .update(baseRevision ?? '').digest('hex');
  const stage = join(root, `source-${key}`);
  const existing = await lstat(stage).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!existing) {
    const build = await mkdtemp(join(root, 'source-build-'));
    await chmod(build, 0o700);
    await hostGit(['clone', '--no-local', '--no-checkout', '--quiet', repository, build], root);
    if (baseRevision) await hostGit(['fetch', '--no-tags', repository, baseRevision], build);
    await hostGit(['checkout', '--detach', revision], build);
    if (baseRevision) await hostGit(['cat-file', '-e', `${baseRevision}^{commit}`], build);
    await rename(build, stage).catch((error) => {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
    });
  }
  const info = await lstat(stage);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid()) ||
      await hostGit(['rev-parse', '--show-toplevel'], stage) !== stage ||
      await hostGit(['config', '--get', 'remote.origin.url'], stage) !== repository ||
      await hostGit(['rev-parse', 'HEAD'], stage) !== revision ||
      await hostGit(['rev-parse', 'HEAD'], repository) !== revision ||
      (baseRevision && await hostGit(['cat-file', '-e', `${baseRevision}^{commit}`], stage) !== '') ||
      await hostGit(['status', '--porcelain=v1'], stage))
    throw new Error('runner_source_stage_invalid');
  return stage;
}

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

function workspaceScope(workspaceRoot) {
  return createHash('sha256').update(workspaceRoot).digest('hex');
}

function workspaceName(configuration) {
  return `morons-${createHash('sha256').update(workspaceFingerprint(configuration)).digest('hex').slice(0, 24)}`;
}

function workspaceFingerprint({ image, repository, reviewRoot, workspaceRoot, workerRoot, reviewWritable }) {
  return createHash('sha256').update(JSON.stringify({ policy: 1, image, repository, reviewRoot,
    workspaceRoot, workerRoot, reviewWritable })).digest('hex');
}

export function workspaceCreateArgs({ image, repository, reviewRoot, workspaceRoot,
  workerRoot = runnerDirectory, reviewWritable = false,
  uid = process.getuid?.(), gid = process.getgid?.() }) {
  if (!validRunnerImage(image) || !Number.isInteger(uid) || !Number.isInteger(gid))
    throw new Error('invalid_runner_configuration');
  const configuration = { image, repository, reviewRoot, workspaceRoot, workerRoot, reviewWritable };
  return [
    'create', '--pull=never', '--name', workspaceName(configuration),
    '--label', `morons.workspace.fingerprint=${workspaceFingerprint(configuration)}`,
    '--label', `morons.workspace.scope=${workspaceScope(workspaceRoot)}`,
    '--network=none', '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges=true', '--pids-limit=64', '--memory=512m',
    '--cpus=1', '--ipc=none', '--user', `${uid}:${gid}`,
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=32m',
    '--env', 'PATH=/usr/local/bin:/usr/bin:/bin', '--env', 'HOME=/home/morons',
    '--env', 'LANG=C', '--env', 'GIT_CONFIG_NOSYSTEM=1',
    '--env', 'GIT_CONFIG_GLOBAL=/dev/null', '--env', 'GIT_TERMINAL_PROMPT=0',
    '--mount', `type=bind,source=${mountPath(repository)},target=/source,readonly`,
    '--mount', `type=bind,source=${mountPath(reviewRoot)},target=/reviews${reviewWritable ? '' : ',readonly'}`,
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
    const timer = setTimeout(() => fail(`container_runner_timeout_${args[0]}`), timeout);
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
  const name = workspaceName(configuration);
  const result = await docker(['container', 'inspect', name], '', 10_000);
  if (result.code !== 0) return null;
  let details;
  try { details = JSON.parse(result.output)?.[0]; } catch { throw new Error('workspace_inspect_failed'); }
  const mounts = details?.Mounts ?? [];
  const expected = [
    [configuration.repository, '/source', false],
    [configuration.reviewRoot, '/reviews', configuration.reviewWritable],
    [configuration.workspaceRoot, '/home/morons', true],
    [configuration.workerRoot, '/worker', false],
  ];
  if (details?.Config?.Labels?.['morons.workspace.fingerprint'] !== workspaceFingerprint(configuration) ||
      details?.Config?.Image !== configuration.image ||
      details?.HostConfig?.NetworkMode !== 'none' ||
      details?.HostConfig?.ReadonlyRootfs !== true ||
      details?.HostConfig?.Privileged !== false ||
      !details?.HostConfig?.CapDrop?.includes('ALL') ||
      !details?.HostConfig?.SecurityOpt?.includes('no-new-privileges=true') ||
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

async function stopWorkspaceScope(workspaceRoot, exceptName = null, grace = '0') {
  const scope = workspaceScope(workspaceRoot);
  const listed = await docker(['container', 'ls', '--all', '--filter',
    `label=morons.workspace.scope=${scope}`, '--format', '{{.ID}}'], '', 10_000);
  if (listed.code !== 0) throw new Error('workspace_scope_inspect_failed');
  for (const id of listed.output.trim().split('\n').filter(Boolean)) {
    const inspected = await docker(['container', 'inspect', id], '', 10_000);
    if (inspected.code !== 0) throw new Error('workspace_scope_inspect_failed');
    let details;
    try { details = JSON.parse(inspected.output)?.[0]; }
    catch { throw new Error('workspace_scope_inspect_failed'); }
    if (!details?.Name?.startsWith('/morons-') ||
        details?.Config?.Labels?.['morons.workspace.scope'] !== scope ||
        details?.HostConfig?.ReadonlyRootfs !== true || details?.HostConfig?.NetworkMode !== 'none' ||
        !details?.Mounts?.some((mount) => mount.Type === 'bind' &&
          mount.Destination === '/home/morons' && mount.Source === workspaceRoot && mount.RW === true))
      throw new Error('workspace_scope_mismatch');
    if (details.Name.slice(1) === exceptName || !details.State?.Running) continue;
    const stopped = await docker(['stop', '--time', grace, id], '', 20_000);
    if (stopped.code !== 0) throw new Error('workspace_stop_failed');
    const after = await docker(['container', 'inspect', id], '', 10_000);
    let state;
    try { state = JSON.parse(after.output)?.[0]?.State; }
    catch { throw new Error('workspace_stop_failed'); }
    if (after.code !== 0 || state?.Running) throw new Error('workspace_stop_failed');
  }
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
  const [sourceStage, workerRoot, runtimeRoot] = await Promise.all([
    committedSourceStage(repository, workspaceRoot, plan.baseRevision), trustedWorkerStage(), privateRuntimeRoot(),
  ]);
  const runtime = runtimeMountPaths(reviewRoot, workspaceRoot, runtimeRoot);
  return { image: plan.runnerImage, repository: sourceStage,
    reviewRoot: runtime.reviewRoot, workspaceRoot: runtime.workspaceRoot,
    hostReviewRoot: reviewRoot, hostWorkspaceRoot: workspaceRoot, runtime,
    workerRoot, reviewWritable: plan.reviewWritable === true };
}

async function provisionWorkspace(configuration) {
  const name = workspaceName(configuration);
  await stopWorkspaceScope(configuration.hostWorkspaceRoot, null, '0');
  if (!knownWorkspaces.has(name)) await stopWorkspaceScope(configuration.workspaceRoot, null, '0');
  await prepareRuntimeMounts(configuration);
  await stopWorkspaceScope(configuration.workspaceRoot,
    !configuration.reviewWritable && knownWorkspaces.has(name) ? name : null);
  let details = await inspectWorkspace(configuration);
  if (!details) {
    const created = await docker(workspaceCreateArgs(configuration), '', 30_000);
    if (created.code !== 0) {
      details = await inspectWorkspace(configuration);
      if (!details) throw new Error('workspace_create_failed');
    } else details = await inspectWorkspace(configuration);
  }
  if (!details?.State?.Running) {
    const started = await docker(['start', name], '', 30_000);
    if (started.code !== 0) throw new Error('workspace_start_failed');
  }
  knownWorkspaces.add(name);
}

export async function openDockerWorkspaceProvider(plan) {
  const configuration = await workspaceConfiguration(plan);
  const name = workspaceName(configuration);
  const key = configuration.workspaceRoot;
  return {
    workspacePath: configuration.workspaceRoot,
    provision: () => serializeWorkspace(key, () => provisionWorkspace(configuration)),
    execute: (input) => serializeWorkspace(key, async () => {
      if (poisonedWorkspaces.has(key)) throw new Error('workspace_requires_manual_recovery');
      await provisionWorkspace(configuration);
      try {
        const result = await docker(['exec', '--interactive', '--workdir', '/worker',
          name, 'node', '/worker/src/worker.mjs'], input, 360_000);
        await checkpointRuntimeMounts(configuration);
        return result;
      } catch (error) {
        poisonedWorkspaces.add(key);
        const stopped = await docker(['stop', '--time', '0', name], '', 20_000).catch(() => null);
        const details = await inspectWorkspace(configuration).catch(() => null);
        if (stopped?.code === 0 && details && !details.State?.Running)
          poisonedWorkspaces.delete(key);
        throw error;
      }
    }),
    stop: () => serializeWorkspace(key, async () => {
      await stopWorkspaceScope(key, null, '10');
      await checkpointRuntimeMounts(configuration);
    }),
  };
}

export async function stopContainerWorkspace(plan) {
  if (!plan?.runnerImage || !plan.workspaceRoot) return;
  const info = await lstat(plan.workspaceRoot);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()))
    throw new Error('private_workspace_directory_required');
  const root = await realpath(plan.workspaceRoot);
  const runtimeRoot = await privateRuntimeRoot();
  const scopes = [root];
  const proposalHomes = join(dirname(root), 'proposal-homes');
  for (const entry of await readdir(proposalHomes, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  })) {
    if (!entry.isDirectory() || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(entry.name)) continue;
    scopes.push(await realpath(join(proposalHomes, entry.name)));
  }
  for (const workspaceRoot of scopes) {
    const reviewRoot = workspaceRoot === root ? plan.reviewRoot :
      join(dirname(plan.reviewRoot), 'proposal-reviews', workspaceRoot.split(sep).at(-1));
    const reviewInfo = await lstat(reviewRoot).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!reviewInfo) {
      await serializeWorkspace(workspaceRoot, () => stopWorkspaceScope(workspaceRoot, null, '10'));
      continue;
    }
    const runtime = runtimeMountPaths(await realpath(reviewRoot), workspaceRoot, runtimeRoot);
    await serializeWorkspace(runtime.workspaceRoot, async () => {
      await stopWorkspaceScope(workspaceRoot, null, '10');
      await stopWorkspaceScope(runtime.workspaceRoot, null, '10');
      const configuration = { runtime, hostReviewRoot: reviewRoot, hostWorkspaceRoot: workspaceRoot };
      if (await lstat(runtime.directory).catch(() => null)) await checkpointRuntimeMounts(configuration);
    });
  }
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
      image, '--version'], '', 60_000);
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
      reviewRoot: await realpath(reviews), workerRoot: await trustedWorkerStage() });
    args.splice(-1, 1, '-e', script);
    const probe = await docker(args, '', 60_000);
    let answer;
    try { answer = JSON.parse(probe.output); } catch { throw new Error('container_boundary_probe_failed'); }
    if (probe.code !== 0 || Object.values(answer).some(Boolean) || Object.keys(answer).length !== 6)
      throw new Error('container_boundary_probe_failed');
  } finally { await rm(probeRoot, { recursive: true, force: true }); }
}

export async function runContainerReviewOperation(plan, operation) {
  if (!validRunnerImage(plan.runnerImage)) throw new Error('runner_image_digest_required');
  trustedCheckPlan(plan.checkProfile, plan.allowedPaths);
  let scopedPlan = { ...plan, reviewWritable: false };
  if (operation.operation === 'review') {
    if (typeof operation.branch !== 'string' ||
        !/^morons-review\/[a-z0-9][a-z0-9-]{0,63}$/.test(operation.branch))
      throw new Error('invalid_review_branch');
    const id = operation.branch.split('/')[1];
    for (const root of [plan.reviewRoot, plan.workspaceRoot]) {
      const parent = join(dirname(root), root === plan.reviewRoot ? 'proposal-reviews' : 'proposal-homes');
      await mkdir(parent, { mode: 0o700 }).catch((error) => {
        if (error.code !== 'EEXIST') throw error;
      });
      for (const path of [parent, join(parent, id)]) {
        await mkdir(path, { mode: 0o700 }).catch((error) => {
          if (error.code !== 'EEXIST') throw error;
        });
        const info = await lstat(path);
        if (!info.isDirectory() || info.isSymbolicLink() ||
            (process.getuid && info.uid !== process.getuid()))
          throw new Error('private_workspace_directory_required');
        await chmod(path, 0o700);
      }
    }
    scopedPlan = { ...plan, reviewRoot: join(dirname(plan.reviewRoot), 'proposal-reviews', id),
      workspaceRoot: join(dirname(plan.workspaceRoot), 'proposal-homes', id), reviewWritable: true };
  }
  if (operation.operation === 'review') scopedPlan.baseRevision = operation.baseRevision;
  const provider = await openDockerWorkspaceProvider(scopedPlan);
  const input = JSON.stringify({ plan: { repository: '/source', reviewRoot: '/reviews',
    allowedPaths: plan.allowedPaths, checkProfile: plan.checkProfile, isolatedClone: true }, ...operation });
  if (Buffer.byteLength(input) > 300_000) throw new Error('review_request_too_large');
  let result;
  try { result = await provider.execute(input); }
  finally { if (operation.operation === 'review') await provider.stop(); }
  let response;
  try { response = JSON.parse(result.output); } catch { throw new Error('container_review_failed'); }
  if (result.code !== 0 || response?.ok !== true) throw new Error('container_review_failed');
  return response.result;
}
