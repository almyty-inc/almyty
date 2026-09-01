/**
 * Where agent-app builds run.
 *
 * Two modes, both supported:
 *
 * - `in-api` (default): the build processor runs inside the API pod and
 *   compiles there. The API image carries bun and rcodesign, so terminal
 *   apps, standalone binaries and macOS signing work; Windows signing and
 *   desktop apps report "not available on this deployment".
 *
 * - `worker`: a dedicated build-worker deployment (the glibc
 *   Dockerfile.builder image, full toolchain) consumes the same queue.
 *   The API pods set `off` so they do not grab build jobs they cannot
 *   fully handle, and the worker sets `worker`.
 *
 * `off` means this process does not consume build jobs at all. It is what
 * an API pod runs once a dedicated worker exists.
 */
export type BuildMode = 'in-api' | 'worker' | 'off';

export function buildMode(env: Record<string, string | undefined> = process.env): BuildMode {
  const raw = (env.APP_BUILD_MODE || '').trim().toLowerCase();
  if (raw === 'worker' || raw === 'off') return raw;
  return 'in-api';
}

/** Whether this process should consume and run build jobs. */
export function buildProcessingEnabled(env?: Record<string, string | undefined>): boolean {
  return buildMode(env) !== 'off';
}

/**
 * Whether builds run on a dedicated worker rather than in this pod.
 *
 * When they do, this pod cannot answer "can we build X" from its own
 * installed tools — it has none — so the capabilities check reports what
 * the worker image is known to carry instead of probing locally.
 */
export function buildsRunOnWorker(env?: Record<string, string | undefined>): boolean {
  return buildMode(env) !== 'in-api';
}
