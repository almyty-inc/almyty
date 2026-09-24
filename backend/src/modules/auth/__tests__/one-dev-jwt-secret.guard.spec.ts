import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

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
    const withoutFallback = readers.filter((f) => !readFileSync(f, 'utf8').includes('DEV_ONLY_JWT_SECRET'));
    expect(withoutFallback).toEqual([]);
  });
});
