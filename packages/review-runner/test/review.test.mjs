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
      checks: [{ file: 'git', args: ['diff', '--check'] }],
    });
    assert.equal(review.baseRevision, base);
    assert.equal(review.sourceDirty, true);
    assert.match(review.diff, /\+after/);
    assert.equal(review.checks[0].ok, true);
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
