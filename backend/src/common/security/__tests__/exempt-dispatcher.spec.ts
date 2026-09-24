import * as http from 'http';
import { AddressInfo } from 'net';

import { dispatcherExempting } from '../exempt-dispatcher';
import { ssrfSafeDispatcher } from '../safe-fetch';

/**
 * The private-URL hatches (MCP_ALLOW_PRIVATE_URLS, a connector's
 * privateUrlsEnv) used to reach an in-cluster name either not at all
 * (the pinned dispatcher refused it) or by dropping the pin for the whole
 * request. The exemption has to be for the one host and nothing else.
 */
describe('dispatcherExempting', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((_req, res) => res.end('ok'));
    port = await new Promise<number>((resolve) =>
      server.listen(0, () => resolve((server.address() as AddressInfo).port)),
    );
  });

  afterAll(() => new Promise((r) => server.close(r)));

  const get = (dispatcher: unknown) =>
    fetch(`http://localhost:${port}/`, { dispatcher, redirect: 'error' } as RequestInit);

  it('the pinned dispatcher refuses a name that resolves to loopback', async () => {
    await expect(get(ssrfSafeDispatcher)).rejects.toMatchObject({ cause: { code: 'ERR_SSRF_BLOCKED' } });
  });

  it('reaches the exempted host', async () => {
    const res = await get(dispatcherExempting('localhost'));
    expect(await res.text()).toBe('ok');
  });

  it('exempts that host only: any other name through it is still pinned', async () => {
    await expect(get(dispatcherExempting('mcp.internal.example'))).rejects.toMatchObject({ cause: { code: 'ERR_SSRF_BLOCKED' } });
  });

  it('reuses one pool per host, case-insensitively', () => {
    expect(dispatcherExempting('LocalHost')).toBe(dispatcherExempting('localhost'));
  });
});
