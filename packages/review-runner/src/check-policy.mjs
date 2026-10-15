// Operator-selected profiles for packages that use only Node's built-in test
// runner. Keep scripts and tests outside the model's exact path allowlist.
const profiles = Object.freeze({
  'review-runner': {
    root: 'packages/review-runner',
    script: 'node --test test/*.test.mjs',
    args: ['--test'],
  },
  optchat: {
    root: 'packages/optchat',
    script: 'node --experimental-strip-types --test test/*.test.mjs',
    args: ['--experimental-strip-types', '--test'],
  },
});

export function trustedCheckPlan(profile, allowedPaths) {
  const selected = profiles[profile];
  if (!selected || !Array.isArray(allowedPaths) || allowedPaths.length === 0 ||
      allowedPaths.some((path) => typeof path !== 'string' ||
        !path.startsWith(`${selected.root}/src/`) || /(^|\/)\.?[^/]*\.test\.[cm]?[jt]s$/.test(path)))
    throw new Error('review_check_profile_does_not_cover_approved_paths');
  return {
    manifest: `${selected.root}/package.json`, script: selected.script,
    checks: [
      { file: 'git', args: ['diff', '--check'], cwd: '.' },
      { file: 'node', args: selected.args, cwd: selected.root },
    ],
  };
}
