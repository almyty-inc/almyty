import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

import { DEV_ONLY_JWT_SECRET, jwtSecretOrDevFallback } from '../dev-jwt-secret';
import { restoreEnv } from '../../../test/env';

/**
 * Every module that signs or verifies session JWTs must fall back to the
 * same secret when JWT_SECRET is unset. A module with its own literal
 * signed cookies that JwtStrategy refused, which is how the MCP consent
 * step came to treat every signed-in CI user as signed out.
 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : sources(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('JWT fallback secret', () => {
  const root = join(__dirname, '..', '..', '..');
  const files = [...sources(join(root, 'modules')), join(root, 'test', 'test-app.module.ts')];

  it('is spelled out in exactly one place', () => {
    const literal = /['"](?:dev-only-jwt-secret-change-me-in-production|dev-jwt-secret|test-jwt-secret)['"]/;
    const offenders = files.filter((f) => !f.endsWith('dev-jwt-secret.ts') && literal.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('is what every session-JWT signer and verifier falls back to', () => {
    const readers = files.filter((f) => /JwtModule\.register|secretOrKey/.test(readFileSync(f, 'utf8')));
    expect(readers.length).toBeGreaterThanOrEqual(5);
    const withoutFallback = readers.filter((f) => {
      const source = readFileSync(f, 'utf8');
      return !source.includes('DEV_ONLY_JWT_SECRET') && !source.includes('jwtSecretOrDevFallback');
    });
    expect(withoutFallback).toEqual([]);
  });

  it('is never used in production, even when JWT_SECRET is set to it', () => {
    const previous = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      expect(() => jwtSecretOrDevFallback(undefined, 'spec')).toThrow(/JWT_SECRET/);
      expect(() => jwtSecretOrDevFallback('', 'spec')).toThrow(/JWT_SECRET/);
      expect(() => jwtSecretOrDevFallback(DEV_ONLY_JWT_SECRET, 'spec')).toThrow(/JWT_SECRET/);
      expect(jwtSecretOrDevFallback('a-real-secret', 'spec')).toBe('a-real-secret');

      process.env.NODE_ENV = 'development';
      expect(jwtSecretOrDevFallback(undefined, 'spec')).toBe(DEV_ONLY_JWT_SECRET);
    } finally {
      restoreEnv('NODE_ENV', previous);
    }
  });
});