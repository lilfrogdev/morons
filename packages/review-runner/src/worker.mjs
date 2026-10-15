import { readSourceAtHead, prepareReview } from './index.mjs';

// One request per short-lived process. The host supplies this plan, never the model.
// The worker has no provider credentials and accepts only two fixed operations.
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 300_000) throw new Error('Review request too large');
}
try {
  const request = JSON.parse(input);
  const plan = request.plan;
  if (!plan || typeof plan.repository !== 'string' || !Array.isArray(plan.allowedPaths))
    throw new Error('Invalid review plan');
  let result;
  if (request.operation === 'read') {
    result = await readSourceAtHead(plan.repository, request.path, plan.allowedPaths);
  } else if (request.operation === 'review') {
    result = await prepareReview({
      repository: plan.repository,
      branch: request.branch,
      patch: request.patch,
      allowedPaths: plan.allowedPaths,
      reviewRoot: plan.reviewRoot ?? null,
      checks: [{ file: 'git', args: ['diff', '--check'] }],
    });
  } else {
    throw new Error('Invalid review operation');
  }
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error?.message ?? 'Review failed' }));
  process.exitCode = 1;
}
