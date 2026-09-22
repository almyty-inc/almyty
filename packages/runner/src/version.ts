/**
 * The runner's own version, read from its package.json at startup.
 *
 * It used to be a hardcoded constant, which drifted: the daemon banner,
 * `almyty-runner version`, and the runnerVersion the backend records in
 * the runner row all answered 0.1.0 while the published package was
 * 1.2.0, so a support thread could not tell which build was connected.
 * Both `dist/version.js` and `src/version.ts` sit one directory below
 * the package root, so the same relative path resolves for the built
 * bin and for `tsx src/cli.ts`.
 */
import { readFileSync } from 'node:fs';

export function readVersion(fallback = '0.0.0'): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
    ) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version.length > 0
      ? pkg.version
      : fallback;
  } catch {
    return fallback;
  }
}

export const VERSION = readVersion();
