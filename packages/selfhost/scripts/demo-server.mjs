import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAccountServer } from '../src/account-server.mjs';


const dir = await mkdtemp(join(tmpdir(), 'morons-ui-demo-'));
const repository = join(dir, 'source');
await mkdir(repository);
const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' });
git('init', '-q');
git('config', 'user.name', 'Demo');
git('config', 'user.email', 'demo@example.invalid');
git('config', 'commit.gpgSign', 'false');
await writeFile(join(repository, 'README.md'), 'before\n');
git('add', 'README.md');
git('commit', '-qm', 'base');
const bootstrapToken = 'disposable-bootstrap-token-for-ui-demo-123456';
const server = await openAccountServer({ dataDir: join(dir, 'data'), bootstrapToken,
  repositoryPlan: { repository, allowedPaths: ['README.md'] } });
const call = async (method, path, data, token, extra = {}) => {
  const response = await fetch(`${server.url}${path}`, { method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
    body: data && JSON.stringify(data) });
  const body = await response.json();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(body)}`);
  return body;
};
await call('POST', '/v1/accounts/bootstrap', { name: 'demo', password: 'disposable-demo-password-123' }, null,
  { 'X-Morons-Bootstrap': bootstrapToken });
const { token } = await call('POST', '/v1/session/login', { name: 'demo', password: 'disposable-demo-password-123' });
await call('POST', '/v1/morons', { id: 'repo', name: 'Repository', rules: 'Read committed source and present changes for review.', preferences: 'Be concise.' }, token);
for (const moron of [
  { id: 'fitness', name: 'Fitness', rules: 'Help with fitness goals.', preferences: 'Be practical.' },
  { id: 'freddy', name: 'Freddy · Finance', rules: 'Help with a grocery budget.', preferences: 'Be concise.' },
  { id: 'goals', name: 'Ongoing goals', rules: 'Track open goals.', preferences: 'Remember decisions.' },
]) await call('POST', '/v1/morons', moron, token);
await call('POST', '/v1/morons/repo/sessions', { id: 'repo' }, token);
await call('POST', '/v1/sessions/repo/chat', { requestId: '11111111-1111-4111-8111-111111111111', text: '/source README.md' }, token);
const patch = 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-before\n+after\n';
await call('POST', '/v1/sessions/repo/chat', { requestId: '22222222-2222-4222-8222-222222222222', text: `/review\n${patch}` }, token);
await call('POST', '/v1/sessions/repo/chat', { requestId: '33333333-3333-4333-8333-333333333333', text: '/viz' }, token);
process.stdout.write(JSON.stringify({ url: server.url, dir, account: 'demo' }) + '\n');
const close = async () => { await server.close(); await rm(dir, { recursive: true, force: true }); process.exit(0); };
process.once('SIGINT', close);
process.once('SIGTERM', close);
