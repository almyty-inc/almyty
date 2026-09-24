import { JwtService } from '@nestjs/jwt';
import * as jsonwebtoken from 'jsonwebtoken';

/**
 * Real JWTs for specs.
 *
 * The global jest setup used to replace `jsonwebtoken` with a double whose
 * `verify` returned a fixed payload for any string at all, so no spec
 * anywhere could see a forged, expired or wrong-secret token rejected.
 * It is gone (pinned by __tests__/no-global-jwt-stub.spec.ts); a spec that
 * needs a token signs a real one here and hands the code under test a real
 * JwtService, so verification is the library's, not the test's.
 */
export const TEST_JWT_SECRET = 'almyty-test-jwt-secret';

export function realJwtService(secret: string = TEST_JWT_SECRET): JwtService {
  return new JwtService({ secret });
}

export function signTestJwt(
  payload: string | object | Buffer,
  options: jsonwebtoken.SignOptions & { secret?: string } = {},
): string {
  const { secret = TEST_JWT_SECRET, ...signOptions } = options;
  return jsonwebtoken.sign(payload, secret, { expiresIn: '5m', ...signOptions });
}

/** A token whose `exp` is already in the past. */
export function signExpiredTestJwt(payload: object, options: { secret?: string } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return jsonwebtoken.sign(
    { ...payload, iat: now - 120, exp: now - 60 },
    options.secret ?? TEST_JWT_SECRET,
  );
}
