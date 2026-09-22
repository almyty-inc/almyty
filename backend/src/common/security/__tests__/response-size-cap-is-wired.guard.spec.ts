import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

import { OAuth2Service } from '../../../modules/credentials/oauth2.service';

/**
 * `validateResponseSize()` shipped in common/security with a full unit
 * test and not one production caller. A unit test of a size check passes
 * exactly as well when nothing calls the size check, which is how it
 * survived every release since it was written.
 *
 * The tool executors never needed it: they go through axios, and
 * `maxContentLength` clamps the stream for them. The call sites that DID
 * need it are the ones on native `fetch`, which has no equivalent —
 * OAuth2's two token-endpoint reads, where `tokenUrl` is operator-supplied
 * and the reply is buffered whole by `await response.json()`.
 *
 * What it guards:
 *   1. something outside a test imports validateResponseSize at all —
 *      the arm that fails the moment the function is orphaned again;
 *   2. neither OAuth2 token read calls `.json()` on the raw response;
 *   3. the cap really refuses, both when the endpoint declares an
 *      oversized content-length and when it declares nothing and streams.
 */
const SRC = join(__dirname, '..', '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === '__tests__' || name === 'test') continue;
      walk(p, out);
    } else if (name.endsWith('.ts') && !name.includes('.spec.')) {
      out.push(p);
    }
  }
  return out;
}

describe('the response-size cap has a production caller', () => {
  it('is imported by at least one non-test module', () => {
    const importers = walk(SRC)
      .filter((f) => !f.endsWith(join('common', 'security', 'url-validator.ts')))
      .filter((f) => /\bvalidateResponseSize\b/.test(readFileSync(f, 'utf8')));

    // Naming them rather than counting: a failure should say what was lost.
    expect(importers.map((f) => f.slice(SRC.length + 1))).toContain(
      join('modules', 'credentials', 'oauth2.service.ts'),
    );
  });

  it('OAuth2 never buffers a token response unchecked', () => {
    const svc = readFileSync(join(SRC, 'modules', 'credentials', 'oauth2.service.ts'), 'utf8');
    expect(svc).toContain('validateResponseSize');
    // The bug this replaced. Both grants went straight to .json().
    expect(svc).not.toMatch(/tokenResponse\.json\(\)/);
    expect((svc.match(/readTokenJson\(tokenResponse\)/g) ?? []).length).toBe(2);
  });
});

describe('the cap refuses an oversized token endpoint', () => {
  const CAP = 256 * 1024;
  const service = () => new OAuth2Service({} as any, {} as any, {} as any);
  const grant = () =>
    service().clientCredentialsGrant({
      organizationId: 'org-1',
      clientId: 'id',
      clientSecret: 'secret',
      tokenUrl: 'https://example.com/token',
    } as any);

  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('refuses a declared content-length over the cap, before reading a byte', () => {
    const read = jest.fn();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: (k: string) => (k === 'content-length' ? String(CAP + 1) : null) },
      body: { getReader: read },
      json: read,
      text: read,
    }) as any;

    return expect(grant()).rejects.toThrow(/over the .* limit/).then(() => {
      expect(read).not.toHaveBeenCalled();
    });
  });

  it('refuses a chunked body that runs past the cap with no content-length', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(64 * 1024));
    let sent = 0;
    const cancel = jest.fn();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () => (sent++ < 8 ? { done: false, value: chunk } : { done: true }),
          cancel,
        }),
      },
    }) as any;

    await expect(grant()).rejects.toThrow(/exceeded the .*-byte limit/);
    // Cancelled rather than drained: the point is not to read the rest.
    expect(cancel).toHaveBeenCalled();
    expect(sent).toBeLessThan(8);
  });

  it('still parses a normal token response', async () => {
    const body = new TextEncoder().encode(JSON.stringify({ error: 'invalid_client' }));
    let sent = 0;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: (k: string) => (k === 'content-length' ? String(body.byteLength) : null) },
      body: {
        getReader: () => ({
          read: async () => (sent++ === 0 ? { done: false, value: body } : { done: true }),
          cancel: jest.fn(),
        }),
      },
    }) as any;

    // Reaching the provider's own error proves the body was read and parsed.
    await expect(grant()).rejects.toThrow(/invalid_client/);
  });
});
