import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
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
  };
}

async function command(file, args, cwd, timeout = 30_000) {
  try {
    const { stdout, stderr } = await exec(file, args, {
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

/**
 * Trusted-caller boundary. The model may supply a patch, but branch name,
 * repository, and check commands must come from an operator-approved plan.
 * This never commits, pushes, merges, or changes the source checkout.
 */
export async function prepareReview({ repository, branch, patch, checks = [] }) {
  if (!validBranch(branch)) throw new Error('Invalid review branch');
  if (typeof patch !== 'string' || !patch || Buffer.byteLength(patch) > MAX_PATCH_BYTES)
    throw new Error('Invalid patch');
  if (!Array.isArray(checks) || checks.length > 8 || checks.some((c) =>
    !c || typeof c.file !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(c.file) ||
    !Array.isArray(c.args) || c.args.length > 24 || c.args.some((a) => typeof a !== 'string' || a.length > 256)))
    throw new Error('Invalid trusted checks');

  const root = await realpath(resolve(repository));
  const inside = await command('git', ['rev-parse', '--show-toplevel'], root);
  if (!inside.ok || inside.stdout.trim() !== root) throw new Error('Repository root required');
  const status = await command('git', ['status', '--porcelain=v1'], root);
  if (!status.ok) throw new Error('Cannot inspect source checkout');
  const revision = await command('git', ['rev-parse', 'HEAD'], root);
  if (!revision.ok) throw new Error('Cannot resolve base revision');

  const directory = await mkdtemp(join(tmpdir(), 'morons-review-'));
  const worktree = join(directory, 'checkout');
  let created = false;
  try {
    const add = await command('git', ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-b', branch, worktree, revision.stdout.trim()], root);
    if (!add.ok) throw new Error(`Cannot create isolated branch: ${add.stderr}`);
    created = true;
    const patchPath = join(directory, 'proposal.patch');
    await writeFile(patchPath, patch, { mode: 0o600 });
    const verify = await command('git', ['apply', '--check', patchPath], worktree);
    if (!verify.ok) throw new Error(`Patch rejected: ${verify.stderr}`);
    const apply = await command('git', ['apply', patchPath], worktree);
    if (!apply.ok) throw new Error(`Patch failed: ${apply.stderr}`);
    const results = [];
    for (const check of checks) {
      const result = await command(check.file, check.args, worktree, 120_000);
      results.push({ file: check.file, args: check.args, ...result });
    }
    const diff = await command('git', ['--no-pager', 'diff', '--no-ext-diff', '--binary', '--'], worktree);
    if (!diff.ok) throw new Error('Cannot produce review diff');
    return { branch, baseRevision: revision.stdout.trim(), sourceDirty: Boolean(status.stdout.trim()), worktree, diff: diff.stdout, checks: results };
  } catch (error) {
    if (created) await command('git', ['worktree', 'remove', '--force', worktree], root);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
