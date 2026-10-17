import { verifyContainerRunner } from './container-review.mjs';

export function unavailableRunner(image, reason) {
  reason = typeof reason === 'string' && /^[a-z0-9_]{1,160}$/.test(reason) ? reason : 'runner_verification_failed';
  const state = reason === 'docker_not_found' ? 'docker-missing' :
    ['container_engine_not_running', 'container_runner_unavailable', 'container_runner_timeout_info'].includes(reason) ? 'docker-stopped' :
    ['runner_image_not_present', 'runner_download_failed'].includes(reason) ? 'image-missing' :
    reason === 'not_configured' ? 'disabled' : reason === 'administrator_required' ? 'restricted' : 'unavailable';
  const message = state === 'docker-missing' ? 'Install Docker Desktop to enable repository coding.' :
    state === 'docker-stopped' ? 'Docker is installed but its engine is not reachable.' :
    reason === 'runner_download_failed' ? 'The runner download failed. Check Docker’s connection or sign-in, then try again.' :
    state === 'image-missing' ? 'Docker is ready. Download the pinned coding runner to continue.' :
    state === 'restricted' ? 'An administrator account is required to set up repository coding.' :
    state === 'disabled' ? 'Repository coding is disabled by the server configuration.' :
    reason === 'runner_image_digest_required' ? 'Configure a runner image pinned by SHA-256 digest.' :
      'The runner safety check failed. Resolve the Docker setup issue, then recheck readiness.';
  return { configured: Boolean(image), available: false, state, activity: null,
    downloadBytes: image === 'docker.io/library/node@sha256:80503c2cadca910dfe16f1516025a2133cdfb0e839f02e79191f83548f2ec729' ? 401699727 : null,
    image: typeof image === 'string' && image.length <= 255 ? image : null, reason, message };
}

export async function inspectRunner(image, unavailableReason = 'not_configured', { signal } = {}) {
  if (!image) return unavailableRunner(null, unavailableReason);
  try {
    await verifyContainerRunner(image, { signal });
    return { configured: true, available: true, state: 'ready', activity: null,
      image, reason: null, message: 'Repository coding ready.' };
  } catch (error) { return unavailableRunner(image, error?.message ?? 'container_runner_unavailable'); }
}
