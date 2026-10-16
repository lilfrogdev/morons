

const profiles = Object.freeze({
  'source-code': {
    root: null,
    script: null,
  },
  'review-runner': {
    root: 'packages/review-runner',
    script: 'node --check src/check-policy.mjs && node --check src/index.mjs && node --check src/worker.mjs',
  },
  optchat: {
    root: 'packages/optchat',
    script: 'node --experimental-strip-types --check src/morons.ts && node --experimental-strip-types --check src/node.ts && node --experimental-strip-types --check src/repo-memory.ts',
  },
});

export function trustedCheckPlan(profile, allowedPaths) {
  const selected = profiles[profile];
  if (!selected || !Array.isArray(allowedPaths) || allowedPaths.length === 0 ||
      allowedPaths.length > 128 || allowedPaths.some((path) => typeof path !== 'string' ||
        (selected.root && !path.startsWith(`${selected.root}/src/`)) ||
        !/^[a-zA-Z0-9_./-]{1,512}$/.test(path) ||
        path.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.')) ||
        /(^|\/)\.?[^/]*\.test\.[cm]?[jt]s$/.test(path)))
    throw new Error('review_check_profile_does_not_cover_approved_paths');
  if (profile === 'source-code') return { checks: [{ file: 'git', args: ['diff', '--check'], cwd: '.' }] };
  return {
    manifest: `${selected.root}/package.json`, scriptName: 'check', script: selected.script,
    checks: [
      { file: 'git', args: ['diff', '--check'], cwd: '.' },
      { file: 'npm', args: ['run', 'check'], cwd: selected.root },
    ],
  };
}
