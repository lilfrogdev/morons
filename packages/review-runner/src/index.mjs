import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const MAX_PATCH_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;

function runnerEnv() {
  // The runner must be launched in a separate, credential-free process. This
  // allowlist is defense in depth; it is not an OS sandbox.
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

/** Read one operator-allowlisted committed file; never offer unrestricted Git reads to a model. */
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

/**
 * Trusted-caller boundary. The model may supply a patch, but branch name,
 * repository, and check commands must come from an operator-approved plan.
 * This commits only on the isolated proposal branch. It never pushes, merges,
 * or changes the source checkout.
 */
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
      typeof requiredScript.script !== 'string' || requiredScript.script.length > 256))
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
        // A container sees the source read-only. Clone into its account-private
        // output mount so Git never writes source .git/worktrees or refs.
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
      if (manifest?.scripts?.test !== requiredScript.script) throw new Error('review_check_script_changed');
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
    // Intent-to-add makes new files visible to both path validation and diff.
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
