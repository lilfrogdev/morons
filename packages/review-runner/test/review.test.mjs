import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareReview, readSourceAtHead } from '../src/index.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

test('proposal changes only isolated branch and returns check evidence', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'morons-source-'));
  let review;
  try {
    git(repository, 'init', '-q');
    git(repository, 'config', 'user.name', 'Fixture');
    git(repository, 'config', 'user.email', 'fixture@example.invalid');
    git(repository, 'config', 'commit.gpgSign', 'false');
    await writeFile(join(repository, 'README.md'), 'before\n');
    git(repository, 'add', 'README.md');
    git(repository, 'commit', '-qm', 'base');
    const base = git(repository, 'rev-parse', 'HEAD');
    // Existing uncommitted work must remain untouched and outside the review.
    await writeFile(join(repository, 'notes.txt'), 'private local notes\n');
    await writeFile(join(repository, 'README.md'), 'uncommitted local edit\n');
    assert.deepEqual(await readSourceAtHead(repository, 'README.md', ['README.md']), {
      path: 'README.md', text: 'before\n',
    });
    await assert.rejects(readSourceAtHead(repository, 'notes.txt', ['notes.txt']), /Committed file required/);
    await assert.rejects(readSourceAtHead(repository, '../notes.txt', ['../notes.txt']), /Invalid source path/);
    await assert.rejects(readSourceAtHead(repository, 'README.md', []), /Source path not approved/);
    review = await prepareReview({
      repository,
      branch: 'morons-review/fixture-1',
      patch: 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-before\n+after\n',
      allowedPaths: ['README.md'],
      checks: [{ file: 'git', args: ['diff', '--check'] }],
    });
    assert.equal(review.baseRevision, base);
    assert.equal(review.sourceDirty, true);
    assert.match(review.diff, /\+after/);
    assert.equal(review.checks[0].ok, true);
    assert.equal(git(repository, 'rev-parse', review.branch), review.proposalRevision);
    assert.equal(git(repository, 'show', `${review.branch}:README.md`), 'after');
    assert.equal(await readFile(join(repository, 'README.md'), 'utf8'), 'uncommitted local edit\n');
    assert.equal(await readFile(join(repository, 'notes.txt'), 'utf8'), 'private local notes\n');
    assert.equal(await readFile(join(review.worktree, 'README.md'), 'utf8'), 'after\n');
    assert.equal(git(repository, 'rev-parse', 'HEAD'), base);
  } finally {
    if (review) git(repository, 'worktree', 'remove', '--force', review.worktree);
    await rm(repository, { recursive: true, force: true });
  }
});

test('rejects invalid branch and oversized patch before touching a repository', async () => {
  await assert.rejects(prepareReview({ repository: '/missing', branch: 'main', patch: 'x' }), /Invalid review branch/);
  await assert.rejects(prepareReview({ repository: '/missing', branch: 'morons-review/test', patch: 'x'.repeat(300_000) }), /Invalid patch/);
});

test('rejects a patch outside the trusted plan', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'morons-reject-'));
  try {
    git(repository, 'init', '-q');
    git(repository, 'config', 'user.name', 'Fixture');
    git(repository, 'config', 'user.email', 'fixture@example.invalid');
    git(repository, 'config', 'commit.gpgSign', 'false');
    await writeFile(join(repository, 'README.md'), 'safe\n');
    await writeFile(join(repository, 'private.txt'), 'old\n');
    git(repository, 'add', '.');
    git(repository, 'commit', '-qm', 'base');
    await assert.rejects(prepareReview({
      repository, branch: 'morons-review/reject-private', allowedPaths: ['README.md'],
      patch: 'diff --git a/private.txt b/private.txt\n--- a/private.txt\n+++ b/private.txt\n@@ -1 +1 @@\n-old\n+new\n',
    }), /unapproved path/);
    assert.equal(await readFile(join(repository, 'private.txt'), 'utf8'), 'old\n');
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test('persistent review worktree retries the same proposal without another commit', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'morons-retry-'));
  const reviewRoot = await mkdtemp(join(tmpdir(), 'morons-review-store-'));
  const patch = 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-before\n+after\n';
  try {
    git(repository, 'init', '-q');
    await writeFile(join(repository, 'README.md'), 'before\n');
    git(repository, 'add', '.');
    git(repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'base');
    const args = { repository, branch: 'morons-review/retry', patch, allowedPaths: ['README.md'],
      reviewRoot, checks: [{ file: 'git', args: ['diff', '--check'] }] };
    const first = await prepareReview(args);
    const second = await prepareReview(args);
    assert.equal(second.proposalRevision, first.proposalRevision);
    assert.equal(second.diff, first.diff);
    assert.equal(git(repository, 'rev-list', '--count', `${first.baseRevision}..${first.branch}`), '1');
  } finally { await rm(repository, { recursive: true, force: true }); await rm(reviewRoot, { recursive: true, force: true }); }
});

test('isolated clone prepares and retries a branch without writing source Git metadata', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'morons-clone-source-'));
  const reviewRoot = await mkdtemp(join(tmpdir(), 'morons-clone-reviews-'));
  const patch = 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-before\n+after\n';
  try {
    git(repository, 'init', '-q');
    await writeFile(join(repository, 'README.md'), 'before\n');
    git(repository, 'add', '.');
    git(repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'base');
    const beforeRefs = git(repository, 'for-each-ref', '--format=%(refname) %(objectname)');
    const beforeWorktrees = git(repository, 'worktree', 'list', '--porcelain');
    await writeFile(join(repository, 'README.md'), 'uncommitted local edit\n');
    const args = { repository, branch: 'morons-review/clone', patch, allowedPaths: ['README.md'],
      reviewRoot, isolatedClone: true, checks: [{ file: 'git', args: ['diff', '--check'] }] };
    const first = await prepareReview(args);
    const second = await prepareReview(args);
    assert.equal(first.proposalRevision, second.proposalRevision);
    assert.equal(first.checks[0].ok, true);
    assert.match(first.diff, /\+after/);
    assert.equal(await readFile(join(repository, 'README.md'), 'utf8'), 'uncommitted local edit\n');
    assert.equal(git(repository, 'for-each-ref', '--format=%(refname) %(objectname)'), beforeRefs);
    assert.equal(git(repository, 'worktree', 'list', '--porcelain'), beforeWorktrees);
    assert.equal(git(first.worktree, 'show', 'HEAD:README.md'), 'after');
  } finally { await rm(repository, { recursive: true, force: true }); await rm(reviewRoot, { recursive: true, force: true }); }
});

test('isolated clone rejects patch traversal and cannot change an approval record', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'morons-escape-source-'));
  const reviewRoot = await mkdtemp(join(tmpdir(), 'morons-escape-reviews-'));
  const approval = join(reviewRoot, 'approval.sqlite');
  try {
    git(repository, 'init', '-q');
    await writeFile(join(repository, 'README.md'), 'safe\n');
    git(repository, 'add', '.');
    git(repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'base');
    await writeFile(approval, 'approved=false\n');
    const escape = 'diff --git a/../approval.sqlite b/../approval.sqlite\n--- a/../approval.sqlite\n+++ b/../approval.sqlite\n@@ -1 +1 @@\n-approved=false\n+approved=true\n';
    await assert.rejects(prepareReview({ repository, branch: 'morons-review/escape',
      patch: escape, allowedPaths: ['README.md'], reviewRoot, isolatedClone: true }), /Patch rejected|Patch failed|unapproved path/);
    assert.equal(await readFile(approval, 'utf8'), 'approved=false\n');
  } finally { await rm(repository, { recursive: true, force: true }); await rm(reviewRoot, { recursive: true, force: true }); }
});

test('pinned review recovers after the source branch advances', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'morons-pinned-source-'));
  const reviewRoot = await mkdtemp(join(tmpdir(), 'morons-pinned-reviews-'));
  const patch = 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-before\n+after\n';
  try {
    git(repository, 'init', '-q');
    await writeFile(join(repository, 'README.md'), 'before\n');
    git(repository, 'add', '.');
    git(repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'base');
    const baseRevision = git(repository, 'rev-parse', 'HEAD');
    const args = { repository, branch: 'morons-review/pinned', patch, allowedPaths: ['README.md'],
      reviewRoot, isolatedClone: true, baseRevision, checks: [{ file: 'git', args: ['diff', '--check'] }] };
    const first = await prepareReview(args);
    await writeFile(join(repository, 'new.txt'), 'later\n');
    git(repository, 'add', 'new.txt');
    git(repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'later');
    const recovered = await prepareReview(args);
    assert.equal(recovered.proposalRevision, first.proposalRevision);
    assert.equal(recovered.baseRevision, baseRevision);
    assert.equal(recovered.diff, first.diff);
  } finally { await rm(repository, { recursive: true, force: true }); await rm(reviewRoot, { recursive: true, force: true }); }
});
