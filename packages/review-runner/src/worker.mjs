import { inspectSource, readSourceAtHead, prepareReview, implementationOperation } from './index.mjs';
import { trustedCheckPlan } from './check-policy.mjs';



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
  if (request.operation === 'inspect') {
    result = await inspectSource(plan.repository);
  } else if (request.operation === 'read') {
    result = await readSourceAtHead(plan.repository, request.path, plan.allowedPaths);
  } else if (request.operation === 'review') {
    let checks = [{ file: 'git', args: ['diff', '--check'] }];
    let requiredScript = null;
    if (plan.checkProfile !== undefined) {
      const policy = trustedCheckPlan(plan.checkProfile, plan.allowedPaths);
      checks = policy.checks;
      if (policy.manifest) requiredScript = { manifest: policy.manifest,
        scriptName: policy.scriptName, script: policy.script };
    }
    result = await prepareReview({
      repository: plan.repository,
      branch: request.branch,
      patch: request.patch,
      allowedPaths: plan.allowedPaths,
      reviewRoot: plan.reviewRoot ?? null,
      isolatedClone: plan.isolatedClone === true,
      baseRevision: request.baseRevision ?? null,
      checks,
      requiredScript,
    });
  } else if (request.operation === 'implementation') {
    if (plan.isolatedClone !== true) throw new Error('implementation_requires_container');
    const policy = trustedCheckPlan(plan.checkProfile, plan.allowedPaths);
    result = await implementationOperation({ repository: plan.repository, reviewRoot: plan.reviewRoot,
      allowedPaths: plan.allowedPaths, branch: request.branch, baseRevision: request.baseRevision,
      action: request.action, path: request.path, text: request.text, callId: request.callId,
      checks: policy.checks, requiredScript: policy.manifest ? { manifest: policy.manifest,
        scriptName: policy.scriptName, script: policy.script } : null });
  } else {
    throw new Error('Invalid review operation');
  }
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error?.message ?? 'Review failed' }));
  process.exitCode = 1;
}
