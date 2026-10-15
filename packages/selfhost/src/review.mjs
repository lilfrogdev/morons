import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const worker = fileURLToPath(new URL('../../review-runner/src/worker.mjs', import.meta.url));
const MAX_RESULT_BYTES = 512 * 1024;

/** Launch one credential-free, no-network review process per operation. */
export async function runReviewOperation(plan, operation) {
  if (!plan || typeof plan.repository !== 'string' || !Array.isArray(plan.allowedPaths) ||
      plan.allowedPaths.length === 0) throw new Error('review_plan_unavailable');
  if (process.platform !== 'darwin') throw new Error('review_sandbox_unavailable');
  // This profile removes network access. Fixed operations and exact source /
  // patch path allowlists are enforced in the worker. Host-level filesystem
  // confinement still needs a platform-specific deployment sandbox.
  const profile = '(version 1)(allow default)(deny network*)';
  const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, worker], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin', HOME: '/tmp', TMPDIR: '/tmp', LANG: 'C' },
    windowsHide: true,
  });
  const input = JSON.stringify({ plan, ...operation });
  if (Buffer.byteLength(input) > 300_000) {
    child.kill();
    throw new Error('review_request_too_large');
  }
  let output = '';
  let errorOutput = '';
  const completion = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('review_timeout')); }, 180_000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (Buffer.byteLength(output) > MAX_RESULT_BYTES) child.kill('SIGKILL');
    });
    child.stderr.on('data', (chunk) => {
      errorOutput += chunk;
      if (Buffer.byteLength(errorOutput) > 4096) child.kill('SIGKILL');
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (Buffer.byteLength(output) > MAX_RESULT_BYTES) return reject(new Error('review_result_too_large'));
      try {
        const response = JSON.parse(output);
        if (!response.ok) return reject(new Error(response.error));
        if (code !== 0) return reject(new Error('review_worker_failed'));
        resolve(response.result);
      } catch { reject(new Error('review_worker_failed')); }
    });
  });
  child.stdin.end(input);
  return completion;
}
