import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { browserLogin, confirmKeyOrganization } from '../browser-login.js';

/**
 * A stand-in API on loopback with one key scoped to org-a, answering
 * /auth/profile the way ApiKeyStrategy does for a mismatched header.
 */
describe('checking the login key against the organization picked', () => {
  let server: Server;
  let api = '';
  const seen: Array<string | undefined> = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      const org = req.headers['x-organization-id'] as string | undefined;
      seen.push(org);
      if (req.headers.authorization !== 'Bearer key-for-org-a') {
        res.writeHead(500).end('unexpected');
      } else if (org === 'org-a') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"data":{}}');
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' })
          .end('{"message":"API key is not scoped to the requested organization","statusCode":401}');
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

  it('accepts a key scoped to the organization it came with', async () => {
    expect(await confirmKeyOrganization(api, 'key-for-org-a', 'org-a')).toBe('ok');
    expect(seen.at(-1)).toBe('org-a');
  });
  it('reports a key scoped to another organization as a mismatch', async () => {
    expect(await confirmKeyOrganization(api, 'key-for-org-a', 'org-b')).toBe('mismatch');
  });
  it('does not fail a login over an unreachable API', async () => {
    expect(await confirmKeyOrganization('http://127.0.0.1:1', 'key-for-org-a', 'org-a')).toBe('unknown');
  });
});

describe('browser login callback', () => {
  it('retains the organization chosen during login beside the credential', async () => {
    let announce!: (url: URL) => void;
    const announced = new Promise<URL>(resolve => { announce = resolve; });
    const login = browserLogin({
      frontendUrl: 'http://127.0.0.1:3238', openBrowser: false, timeoutMs: 5_000,
      log: message => { if (message.includes('/cli-login?')) announce(new URL(message.trim())); },
    });
    const url = await announced;
    const callback = url.searchParams.get('callback')!.replace('/cb', '/cb-complete');
    const response = await fetch(callback, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: url.searchParams.get('state'), token: 'local-test-only', organizationId: 'org-picked' }) });
    expect(response.status).toBe(200);
    expect(await login).toEqual({ token: 'local-test-only', frontendUrl: 'http://127.0.0.1:3238', organizationId: 'org-picked' });
  });
});
