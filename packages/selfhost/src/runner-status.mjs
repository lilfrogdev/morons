import { verifyContainerRunner } from './container-review.mjs';

export function unavailableRunner(image, reason) {
  reason = typeof reason === 'string' && /^[a-z0-9_]{1,160}$/.test(reason) ? reason : 'runner_verification_failed';
  const message = reason === 'administrator_required' ? 'An administrator account is required for repository coding.' :
    reason === 'not_configured' ? 'Repository coding is disabled. Configure a pinned Docker runner image to enable it.' :
    reason === 'runner_image_digest_required' ? 'Repository coding is unavailable. Configure an image pinned by SHA-256 digest.' :
    reason === 'runner_image_not_present' ? 'Repository coding is unavailable. Install the configured Docker image, then restart Morons.' :
    ['container_engine_not_running', 'container_runner_unavailable'].includes(reason) ?
      'Repository coding is unavailable. Install or open Docker Desktop, then restart Morons.' :
      'Repository coding is unavailable. The Docker runner safety check failed; restart Morons after resolving it.';
  return { configured: Boolean(image), available: false,
    image: typeof image === 'string' && image.length <= 255 ? image : null, reason, message };
}

export async function inspectRunner(image, unavailableReason = 'not_configured') {
  if (!image) return unavailableRunner(null, unavailableReason);
  try {
    await verifyContainerRunner(image);
    return { configured: true, available: true, image, reason: null, message: 'Repository coding ready.' };
  } catch (error) { return unavailableRunner(image, error?.message ?? 'container_runner_unavailable'); }
}
