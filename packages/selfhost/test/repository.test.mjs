import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openAccountServer } from '../src/account-server.mjs';
import { openCatalog } from '../src/catalog.mjs';

function git(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); }

test('repo moron reads committed source and prepares a reviewed patch without changing the source checkout', async (t) => {
  if (process.platform !== 'darwin') return t.skip('review worker requires macOS sandbox-exec');
  const dir = await mkdtemp(join(tmpdir(), 'morons-repo-flow-'));
  const repository = join(dir, 'source');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(repository);
  let server;
  try {
    git(repository, 'init', '-q');
    git(repository, 'config', 'user.name', 'Fixture');
    git(repository, 'config', 'user.email', 'fixture@example.invalid');
    git(repository, 'config', 'commit.gpgSign', 'false');
    await writeFile(join(repository, 'README.md'), 'before\n');
    await writeFile(join(repository, 'private.txt'), 'private committed\n');
    git(repository, 'add', '.'); git(repository, 'commit', '-qm', 'base');
    const base = git(repository, 'rev-parse', 'HEAD');
    await writeFile(join(repository, 'README.md'), 'uncommitted local edit\n');
    const bootstrapToken = 'offline-bootstrap-token-for-repository-flow';
    const path = join(dir, 'account-data');
    let token;
    const call = async (method, route, data) => {
      const response = await fetch(`${server.url}${route}`, { method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(route === '/v1/accounts/bootstrap' ? { 'X-Morons-Bootstrap': bootstrapToken } : {}) },
        body: data && JSON.stringify(data) });
      return { status: response.status, ...(await response.json()) };
    };
    server = await openAccountServer({ dataDir: path, bootstrapToken,
      repositoryPlan: { repository, allowedPaths: ['README.md'] } });
    const bootstrapped = await call('POST', '/v1/accounts/bootstrap', { name: 'owner', password: 'offline-password-for-test' });
    assert.equal(bootstrapped.status, 201);
    token = (await call('POST', '/v1/session/login', { name: 'owner', password: 'offline-password-for-test' })).token;
    assert.ok(token);
    assert.equal((await call('POST', '/v1/morons', { id: 'repo', name: 'Repository', rules: 'Review source', preferences: '' })).status, 201);
    const created = await call('POST', '/v1/morons/repo/sessions', { id: 'repo-main' });
    assert.equal(created.status, 201, JSON.stringify(created));
    const source = await call('POST', '/v1/sessions/repo-main/chat', {
      requestId: '11111111-1111-4111-8111-111111111111', text: '/source README.md',
    });
    assert.equal(source.status, 200, JSON.stringify(source));
    assert.match(source.answer, /Committed README.md:[\s\S]*before/);
    assert.ok(!source.answer.includes('uncommitted local edit'));
    const projected = await call('GET', '/v1/sessions/repo-main/history');
    assert.ok(projected.messages.every((item) => typeof item.id === 'string' && item.text.length > 0));
    const forbidden = await call('POST', '/v1/sessions/repo-main/chat', {
      requestId: '22222222-2222-4222-8222-222222222222', text: '/source private.txt',
    });
    assert.ok(!JSON.stringify(forbidden).includes('private committed'));
    const patch = 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-before\n+after\n';
    const proposal = await call('POST', '/v1/sessions/repo-main/chat', {
      requestId: '33333333-3333-4333-8333-333333333333', text: `/review\n${patch}`,
    });
    assert.equal(proposal.status, 200, JSON.stringify(proposal));
    const reviews = await call('GET', '/v1/sessions/repo-main/reviews');
    assert.equal(reviews.reviews.length, 1);
    const review = reviews.reviews[0];
    assert.equal(review.diff, undefined);
    const detail = (await call('GET', `/v1/reviews/${review.id}`)).review;
    assert.equal(review.baseRevision, base);
    assert.equal(review.checks[0].ok, true);
    assert.match(detail.diff, /\+after/);
    assert.equal(git(repository, 'show', `${review.branch}:README.md`), 'after');
    assert.equal(review.decision, 'pending');
    assert.equal(await readFile(join(repository, 'README.md'), 'utf8'), 'uncommitted local edit\n');
    assert.equal(git(repository, 'rev-parse', 'HEAD'), base);
    assert.equal((await call('POST', `/v1/reviews/${review.id}/decision`, { decision: 'approve' })).review.decision, 'approve');
    await server.close();
    const catalog = openCatalog(join(path, 'accounts', bootstrapped.account.id, 'pi.sqlite.catalog.sqlite'));
    catalog.reserveReview({ id: 'bbbbbbbbbbbbbbbb', sessionId: 'repo-main', branch: 'morons-review/bbbbbbbbbbbbbbbb', patch });
    catalog.close();
    server = await openAccountServer({ dataDir: path, bootstrapToken,
      repositoryPlan: { repository, allowedPaths: ['README.md'] } });
    const afterRestart = (await call('GET', '/v1/sessions/repo-main/reviews')).reviews;
    assert.equal(afterRestart.length, 2);
    assert.equal(afterRestart.find((item) => item.id === review.id).decision, 'approve');
    assert.equal(git(repository, 'show', 'morons-review/bbbbbbbbbbbbbbbb:README.md'), 'after');
  } finally {
    await server?.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
