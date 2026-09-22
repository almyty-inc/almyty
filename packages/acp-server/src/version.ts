/**
 * The server's own version, read from its package.json at startup.
 *
 * Every other CLI in the suite answers `--version`; this one shipped
 * without it, so the only way to tell which build a client had loaded
 * was to diff the file. Reading package.json rather than restating the
 * number keeps it honest across a publish: a literal does not move when
 * the release workflow bumps the manifest. Both `dist/version.js` and
 * `src/version.ts` sit one directory below the package root, so the same
 * relative path resolves for the built bin and for `tsx src/index.ts`.
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
