import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile, lstat, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const MAX_PATCH_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;

function runnerEnv() {


  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LANG: 'C',
    HOME: tmpdir(),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TEMPLATE_DIR: '/dev/null',
    GIT_LFS_SKIP_SMUDGE: '1',
  };
}

async function command(file, args, cwd, timeout = 30_000) {
  try {
    const safeArgs = file === 'git' ? ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args] : args;
    const { stdout, stderr } = await exec(file, safeArgs, {
      cwd,
      env: runnerEnv(),
      timeout,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout ?? '').slice(0, MAX_OUTPUT_BYTES),
      stderr: String(error.stderr ?? '').slice(0, MAX_OUTPUT_BYTES),
      code: error.code ?? null,
    };
  }
}

function validBranch(value) {
  return /^morons-review\/[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}

function validSourcePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 &&
    !value.startsWith('/') && !value.includes('\\') && !value.includes(':') &&
    value.split('/').every((part) => part && part !== '.' && part !== '..' && part !== '.git');
}


export async function readSourceAtHead(repository, relativePath, allowedPaths) {
  if (!validSourcePath(relativePath)) throw new Error('Invalid source path');
  if (!Array.isArray(allowedPaths) || !allowedPaths.includes(relativePath))
    throw new Error('Source path not approved');
  const root = await realpath(resolve(repository));
  const inside = await command('git', ['rev-parse', '--show-toplevel'], root);
  if (!inside.ok || inside.stdout.trim() !== root) throw new Error('Repository root required');
  const kind = await command('git', ['cat-file', '-t', `HEAD:${relativePath}`], root);
  if (!kind.ok || kind.stdout.trim() !== 'blob') throw new Error('Committed file required');
  const bytes = await command('git', ['cat-file', '-s', `HEAD:${relativePath}`], root);
  if (!bytes.ok || Number(bytes.stdout.trim()) > MAX_OUTPUT_BYTES) throw new Error('Source file too large');
  const source = await command('git', ['show', `HEAD:${relativePath}`], root);
  if (!source.ok || source.stdout.includes('\0')) throw new Error('Text source required');
  return { path: relativePath, text: source.stdout };
}

export async function inspectSource(repository) {
  const root = await realpath(resolve(repository));
  const inside = await command('git', ['rev-parse', '--show-toplevel'], root);
  if (!inside.ok || inside.stdout.trim() !== root) throw new Error('Repository root required');
  const head = await command('git', ['rev-parse', 'HEAD'], root);
  if (!head.ok || !/^[0-9a-f]{40}$/.test(head.stdout.trim())) throw new Error('Cannot resolve base revision');
  return { baseRevision: head.stdout.trim() };
}







export async function prepareReview({ repository, branch, patch, allowedPaths, checks = [], requiredScript = null, reviewRoot = null, isolatedClone = false, baseRevision = null }) {
  if (!validBranch(branch)) throw new Error('Invalid review branch');
  if (typeof patch !== 'string' || !patch || Buffer.byteLength(patch) > MAX_PATCH_BYTES)
    throw new Error('Invalid patch');
  if (baseRevision !== null && (typeof baseRevision !== 'string' || !/^[0-9a-f]{40}$/.test(baseRevision)))
    throw new Error('Invalid base revision');
  if (!Array.isArray(allowedPaths) || allowedPaths.length === 0 ||
      allowedPaths.length > 128 || allowedPaths.some((path) => !validSourcePath(path)))
    throw new Error('Approved patch paths required');
  if (!Array.isArray(checks) || checks.length > 8 || checks.some((c) =>
    !c || typeof c.file !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(c.file) ||
    (c.cwd !== undefined && c.cwd !== '.' && !validSourcePath(c.cwd)) ||
    !Array.isArray(c.args) || c.args.length > 24 || c.args.some((a) => typeof a !== 'string' || a.length > 256)))
    throw new Error('Invalid trusted checks');
  if (requiredScript !== null && (!validSourcePath(requiredScript.manifest) ||
      requiredScript.scriptName !== 'check' ||
      typeof requiredScript.script !== 'string' || requiredScript.script.length > 512))
    throw new Error('Invalid trusted script');

  const root = await realpath(resolve(repository));
  const inside = await command('git', ['rev-parse', '--show-toplevel'], root);
  if (!inside.ok || inside.stdout.trim() !== root) throw new Error('Repository root required');
  const status = await command('git', ['status', '--porcelain=v1'], root);
  if (!status.ok) throw new Error('Cannot inspect source checkout');
  const revision = baseRevision ? { ok: true, stdout: baseRevision } : await command('git', ['rev-parse', 'HEAD'], root);
  if (!revision.ok || !/^[0-9a-f]{40}$/.test(revision.stdout.trim())) throw new Error('Cannot resolve base revision');
  const baseType = await command('git', ['cat-file', '-t', revision.stdout.trim()], root);
  if (!baseType.ok || baseType.stdout.trim() !== 'commit') throw new Error('Pinned base commit unavailable');

  if (reviewRoot !== null && (typeof reviewRoot !== 'string' || !reviewRoot.startsWith('/')))
    throw new Error('Invalid review storage');
  if (reviewRoot) await mkdir(reviewRoot, { recursive: true, mode: 0o700 });
  const directory = reviewRoot ? join(reviewRoot, branch.split('/')[1]) : await mkdtemp(join(tmpdir(), 'morons-review-'));
  if (reviewRoot) await mkdir(directory, { recursive: true, mode: 0o700 });
  const worktree = join(directory, 'checkout');
  let created = false;
  try {
    const patchPath = join(directory, 'proposal.patch');
    const previous = await readFile(patchPath, 'utf8').catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (previous !== null && previous !== patch) throw new Error('Review id already used for another patch');
    if (previous === null) await writeFile(patchPath, patch, { mode: 0o600, flag: 'wx' });
    const present = await stat(worktree).then((item) => item.isDirectory()).catch(() => false);
    if (!present) {
      if (isolatedClone) {


        const clone = await command('git', ['clone', '--no-local', '--no-checkout', '--quiet', root, worktree], directory, 120_000);
        if (!clone.ok) throw new Error(`Cannot clone committed source: ${clone.stderr}`);
        created = true;
        const branchCreate = await command('git', ['checkout', '-b', branch, revision.stdout.trim()], worktree);
        if (!branchCreate.ok) throw new Error(`Cannot create isolated branch: ${branchCreate.stderr}`);
      } else {
        const add = await command('git', ['worktree', 'add', '-b', branch, worktree, revision.stdout.trim()], root);
        if (!add.ok) throw new Error(`Cannot create isolated branch: ${add.stderr}`);
        created = true;
      }
    }
    const checkedBranch = await command('git', ['symbolic-ref', '--short', 'HEAD'], worktree);
    if (!checkedBranch.ok || checkedBranch.stdout.trim() !== branch) throw new Error('Review worktree branch mismatch');
    if (requiredScript) {
      const manifest = JSON.parse(await readFile(join(worktree, requiredScript.manifest), 'utf8'));
      if (manifest?.scripts?.[requiredScript.scriptName] !== requiredScript.script) throw new Error('review_check_script_changed');
    }
    const base = await command('git', ['rev-parse', `${branch}^`], worktree);
    const finished = base.ok && base.stdout.trim() === revision.stdout.trim();
    if (finished) {
      const proposal = await command('git', ['rev-parse', 'HEAD'], worktree);
      const diff = await command('git', ['--no-pager', 'diff', '--no-ext-diff', '--binary', revision.stdout.trim(), branch], worktree);
      if (!proposal.ok || !diff.ok) throw new Error('Cannot recover committed proposal');
      const results = [];
      for (const check of checks) results.push({ file: check.file, args: check.args,
        cwd: check.cwd ?? '.', ...await command(check.file,
          check.file === 'git' && check.args.join('\0') === 'diff\0--check' ?
            ['diff', '--check', revision.stdout.trim(), branch] : check.args,
          join(worktree, check.cwd ?? '.'), 120_000) });
      return { branch, baseRevision: revision.stdout.trim(), proposalRevision: proposal.stdout.trim(),
        sourceDirty: Boolean(status.stdout.trim()), worktree, diff: diff.stdout, checks: results };
    }
    const head = await command('git', ['rev-parse', 'HEAD'], worktree);
    if (!head.ok || head.stdout.trim() !== revision.stdout.trim()) throw new Error('Review branch has unexpected history');
    const alreadyApplied = await command('git', ['apply', '--reverse', '--check', patchPath], worktree);
    if (!alreadyApplied.ok) {
      const verify = await command('git', ['apply', '--check', patchPath], worktree);
      if (!verify.ok) throw new Error(`Patch rejected: ${verify.stderr}`);
      const apply = await command('git', ['apply', patchPath], worktree);
      if (!apply.ok) throw new Error(`Patch failed: ${apply.stderr}`);
    }

    const intent = await command('git', ['add', '-N', '--', '.'], worktree);
    if (!intent.ok) throw new Error('Cannot inspect patch paths');
    const changed = await command('git', ['diff', '--name-only', '-z', '--no-ext-diff', '--'], worktree);
    if (!changed.ok) throw new Error('Cannot inspect patch paths');
    const paths = changed.stdout.split('\0').filter(Boolean);
    if (paths.length === 0 || paths.some((path) => !allowedPaths.includes(path)))
      throw new Error('Patch touches an unapproved path');
    const results = [];
    for (const check of checks) {
      const result = await command(check.file, check.args, join(worktree, check.cwd ?? '.'), 120_000);
      results.push({ file: check.file, args: check.args, cwd: check.cwd ?? '.', ...result });
    }
    const diff = await command('git', ['--no-pager', 'diff', '--no-ext-diff', '--binary', '--'], worktree);
    if (!diff.ok) throw new Error('Cannot produce review diff');
    const stage = await command('git', ['add', '--', ...paths], worktree);
    if (!stage.ok) throw new Error('Cannot stage approved review paths');
    const commit = await command('git', ['-c', 'user.name=Morons Review', '-c', 'user.email=review@morons.invalid',
      '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--no-verify', '-m', `Review proposal ${branch}`], worktree);
    if (!commit.ok) throw new Error('Cannot commit isolated proposal');
    const proposal = await command('git', ['rev-parse', 'HEAD'], worktree);
    if (!proposal.ok) throw new Error('Cannot resolve proposal revision');
    return { branch, baseRevision: revision.stdout.trim(), proposalRevision: proposal.stdout.trim(),
      sourceDirty: Boolean(status.stdout.trim()), worktree, diff: diff.stdout, checks: results };
  } catch (error) {
    if (!reviewRoot) {
      if (created && !isolatedClone) await command('git', ['worktree', 'remove', '--force', worktree], root);
      await rm(directory, { recursive: true, force: true });
    }
    throw error;
  }
}


export async function implementationOperation({ repository, reviewRoot, allowedPaths, branch, baseRevision,
  action, path, text, callId, checks = [], requiredScript = null }) {
  if (!validBranch(branch) || !/^[0-9a-f]{40}$/.test(baseRevision) || !reviewRoot ||
      !Array.isArray(allowedPaths) || !allowedPaths.length || allowedPaths.length > 128 ||
      allowedPaths.some((item) => !validSourcePath(item))) throw new Error('invalid_implementation_plan');
  const directory = join(reviewRoot, branch.split('/')[1]);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const worktree = join(directory, 'checkout');
  const metadataPath = join(directory, 'implementation.json');
  const binding = JSON.stringify({ branch, baseRevision, allowedPaths });
  let metadata = await readFile(metadataPath, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (metadata !== null && metadata !== binding) throw new Error('implementation_plan_conflict');
  if (metadata === null) await writeFile(metadataPath, binding, { mode: 0o600, flag: 'wx' });
  if (!await stat(worktree).catch(() => null)) {
    const clone = await command('git', ['clone', '--no-local', '--no-checkout', '--quiet', repository, worktree], directory, 120_000);
    if (!clone.ok) throw new Error('implementation_clone_failed');
  }
  const selected = await command('git', ['symbolic-ref', '--short', 'HEAD'], worktree);
  if (!selected.ok || selected.stdout.trim() !== branch) {
    const checkout = await command('git', ['checkout', '-b', branch, baseRevision], worktree);
    if (!checkout.ok) throw new Error('implementation_checkout_failed');
  }
  const sealPath = join(directory, 'implementation-sealed.json');
  const sealed = await readFile(sealPath, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (sealed) {
    if (action !== 'finalize') throw new Error('implementation_already_sealed');
    const result = JSON.parse(sealed);
    const head = await command('git', ['rev-parse', 'HEAD'], worktree);
    const diff = await command('git', ['diff', '--no-ext-diff', '--binary', baseRevision, 'HEAD'], worktree);
    const dirty = await command('git', ['status', '--porcelain=v1'], worktree);
    if (!head.ok || head.stdout.trim() !== result.proposalRevision || !diff.ok ||
        diff.stdout !== result.diff || !dirty.ok || dirty.stdout.trim()) throw new Error('implementation_seal_changed');
    return result;
  }
  const head = await command('git', ['rev-parse', 'HEAD'], worktree);
  const parent = await command('git', ['rev-parse', 'HEAD^'], worktree);
  if (!head.ok || (head.stdout.trim() !== baseRevision &&
      !(action === 'finalize' && parent.ok && parent.stdout.trim() === baseRevision)))
    throw new Error('implementation_history_changed');
  if (action === 'read' || action === 'write') {
    if (!allowedPaths.includes(path) || !validSourcePath(path)) throw new Error('implementation_path_forbidden');
    let current = worktree;
    for (const part of path.split('/')) {
      current = join(current, part);
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error('implementation_symlink_forbidden');
    }
    const info = await lstat(current);
    if (!info.isFile() || info.size > MAX_OUTPUT_BYTES) throw new Error('implementation_regular_text_required');
    if (action === 'read') {
      const contents = await readFile(current, 'utf8');
      if (contents.includes('\0')) throw new Error('implementation_text_required');
      return { path, text: contents };
    }
    if (typeof text !== 'string' || text.includes('\0') || Buffer.byteLength(text) > MAX_OUTPUT_BYTES ||
        typeof callId !== 'string' || !/^[a-f0-9]{64}$/.test(callId)) throw new Error('invalid_implementation_write');
    const receipt = join(directory, `write-${callId}.json`);
    const requested = JSON.stringify({ path, text });
    const previous = await readFile(receipt, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (previous && previous !== requested) throw new Error('implementation_write_conflict');
    if (!previous) {
      const temporary = join(directory, `write-${callId}.tmp`);
      await writeFile(temporary, text, { mode: info.mode & 0o777 });
      await rename(temporary, current);
      await writeFile(receipt, requested, { mode: 0o600, flag: 'wx' });
    }
    return { path, bytes: Buffer.byteLength(text) };
  }
  if (action !== 'check' && action !== 'finalize') throw new Error('invalid_implementation_action');
  if (requiredScript) {
    const manifest = JSON.parse(await readFile(join(worktree, requiredScript.manifest), 'utf8'));
    if (manifest?.scripts?.[requiredScript.scriptName] !== requiredScript.script) throw new Error('review_check_script_changed');
  }
  const changed = await command('git', ['diff', '--name-only', '-z', baseRevision, '--'], worktree);
  const untracked = await command('git', ['ls-files', '--others', '--exclude-standard', '-z'], worktree);
  const paths = changed.stdout.split('\0').filter(Boolean);
  if (!changed.ok || !untracked.ok || untracked.stdout || paths.some((item) => !allowedPaths.includes(item)))
    throw new Error('implementation_paths_changed');
  const results = [];
  for (const check of checks) results.push({ file: check.file, args: check.args, cwd: check.cwd ?? '.',
    ...await command(check.file, check.file === 'git' && check.args.join('\0') === 'diff\0--check' ?
      ['diff', '--check', baseRevision] : check.args, join(worktree, check.cwd ?? '.'), 120_000) });
  const diff = await command('git', ['diff', '--no-ext-diff', '--binary', baseRevision, '--'], worktree);
  if (!diff.ok || Buffer.byteLength(diff.stdout) > MAX_OUTPUT_BYTES) throw new Error('implementation_diff_too_large');
  if (action === 'check') return { baseRevision, diff: diff.stdout, checks: results };
  if (!paths.length) throw new Error('implementation_no_changes');
  if (head.stdout.trim() === baseRevision) {
    const stage = await command('git', ['add', '--', ...paths], worktree);
    if (!stage.ok) throw new Error('implementation_stage_failed');
    const commit = await command('git', ['-c', 'user.name=Morons Implementation', '-c',
      'user.email=implementation@morons.invalid', '-c', 'commit.gpgSign=false', 'commit', '--no-verify',
      '-m', `Implementation proposal ${branch}`], worktree);
    if (!commit.ok) throw new Error('implementation_commit_failed');
  }
  const proposal = await command('git', ['rev-parse', 'HEAD'], worktree);
  if (!proposal.ok) throw new Error('implementation_revision_failed');
  const result = { branch, baseRevision, proposalRevision: proposal.stdout.trim(), diff: diff.stdout,
    diffHash: createHash('sha256').update(diff.stdout).digest('hex'), checks: results };
  await writeFile(sealPath, JSON.stringify(result), { mode: 0o600, flag: 'wx' });
  return result;
}
