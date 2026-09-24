import { readFileSync } from 'fs';
import { join } from 'path';
import * as jsonwebtoken from 'jsonwebtoken';
import { JwtService } from '@nestjs/jwt';

import { TEST_JWT_SECRET, signExpiredTestJwt, signTestJwt } from '../jwt';

/**
 * The global jest setup runs before every spec. It used to mock
 * `jsonwebtoken` so that `verify` returned `{ sub: 'user-id' }` for any
 * input: every real JwtService in every spec accepted forged, expired and
 * wrong-secret tokens, so a verification regression could land with the
 * suite green. These pin that the library is real under the setup.
 */
describe('global jest setup and jsonwebtoken', () => {
  it('jsonwebtoken.verify rejects a token signed with another secret', () => {
    const token = signTestJwt({ sub: 'u1' }, { secret: 'someone-else' });
    expect(() => jsonwebtoken.verify(token, TEST_JWT_SECRET)).toThrow(/invalid signature/);
  });

  it('jsonwebtoken.verify rejects garbage and expired tokens and returns the real payload', () => {
    expect(() => jsonwebtoken.verify('not-a-jwt', TEST_JWT_SECRET)).toThrow(/jwt malformed/);
    expect(() => jsonwebtoken.verify(signExpiredTestJwt({ sub: 'u1' }), TEST_JWT_SECRET)).toThrow(
      /jwt expired/,
    );
    const payload = jsonwebtoken.verify(signTestJwt({ sub: 'u1' }), TEST_JWT_SECRET) as jsonwebtoken.JwtPayload;
    expect(payload.sub).toBe('u1');
  });

  it('a real JwtService signs distinct tokens and only verifies its own', () => {
    const jwt = new JwtService({ secret: TEST_JWT_SECRET });
    const a = jwt.sign({ sub: 'a' });
    const b = jwt.sign({ sub: 'b' });
    expect(a).not.toBe(b);
    expect(jwt.verify(a).sub).toBe('a');
    expect(() => new JwtService({ secret: 'other' }).verify(a)).toThrow(/invalid signature/);
  });

  it('the setup file does not mock jsonwebtoken or @nestjs/jwt', () => {
    const source = readFileSync(join(__dirname, '..', 'setup.ts'), 'utf8');
    expect(source).not.toMatch(/jest\.(mock|doMock)\(\s*['"`](jsonwebtoken|@nestjs\/jwt)['"`]/);
  });
});
