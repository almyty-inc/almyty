/**
 * The CLI's own version, read from its package.json at startup.
 *
 * It used to be a hardcoded string, which drifted: `--version`
 * answered 0.1.0 while the published package was 1.2.0, so a bug
 * report never identified the build it came from. Both `dist/index.js`
 * and `src/index.ts` sit one directory below the package root, so the
 * same relative path resolves for the built bin and for `tsx src/index.ts`.
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
