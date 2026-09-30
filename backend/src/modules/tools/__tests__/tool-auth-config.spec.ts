import { BadRequestException } from '@nestjs/common';

import { assertRegistryHoldsNoSecret, assertToolAuthHoldsNoSecret } from '../tool-auth-config';

/** A tool says which credential it uses; a secret sent with it is refused, not stored. */
describe('a tool keeps no key of its own', () => {
  it('takes how the tool signs its calls and the credential it uses', () => {
    expect(() => assertToolAuthHoldsNoSecret({ type: 'apiKey', config: { credentialId: 'cred-1', headerName: 'X-API-Key' } })).not.toThrow();
    expect(() => assertToolAuthHoldsNoSecret({ type: 'basic', config: { credentialId: 'cred-2' } })).not.toThrow();
    expect(() => assertToolAuthHoldsNoSecret(undefined)).not.toThrow();
    expect(() => assertToolAuthHoldsNoSecret({ type: 'none' })).not.toThrow();
  });

  it.each([
    [{ type: 'bearer', config: { token: 't0ken' } }, 'token'],
    [{ type: 'apiKey', config: { key: 'k', headerName: 'X-Key' } }, 'key'],
    [{ type: 'basic', config: { username: 'ada', password: 'hunter2' } }, 'password'],
  ])('refuses %j, naming %s', (authConfig, field) => {
    try {
      assertToolAuthHoldsNoSecret(authConfig);
      throw new Error('accepted a secret');
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      const body = (e as BadRequestException).getResponse() as { code: string; message: string };
      expect(body.code).toBe('TOOL_SECRET_INLINE');
      expect(body.message).toContain(field);
      expect(body.message).not.toMatch(/t0ken|hunter2/);
    }
  });
});

describe('a private npm registry keeps no token of its own', () => {
  it('takes its address, scope and the credential with its token', () => {
    expect(() => assertRegistryHoldsNoSecret({ url: 'https://npm.acme.dev', scope: '@acme', credentialId: 'cred-9' })).not.toThrow();
    expect(() => assertRegistryHoldsNoSecret(null)).not.toThrow();
  });

  it('refuses a token sent with it', () => {
    expect(() => assertRegistryHoldsNoSecret({ url: 'https://npm.acme.dev', token: 'npm_x' })).toThrow(BadRequestException);
    expect(() => assertRegistryHoldsNoSecret({ url: 'https://npm.acme.dev', authToken: 'npm_y' })).toThrow(BadRequestException);
  });
});
