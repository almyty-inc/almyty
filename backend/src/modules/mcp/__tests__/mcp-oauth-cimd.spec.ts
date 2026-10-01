import * as net from 'net';
import { AddressInfo } from 'net';

import {
  CimdFetchResult,
  McpOAuthCimdService,
  cimdCacheSeconds,
  parseCimdDocument,
  safeCimdFetcher,
} from '../services/mcp-oauth-cimd.service';
import { McpOAuthService } from '../services/mcp-oauth.service';
import { findGatewayClient } from '../services/mcp-oauth-helpers.helper';
import { cimdSettings } from '../core/mcp-settings';
import { fakeRepository } from '../../../test/fake-repository';
import { snapshotEnv } from '../../../test/env';

const URL_ID = 'https://client.example.com/oauth/client.json';

const docFor = (over: Record<string, any> = {}) =>
  JSON.stringify({
    client_id: URL_ID,
    client_name: 'Example Client',
    redirect_uris: ['http://127.0.0.1:33418/callback'],
    token_endpoint_auth_method: 'none',
    ...over,
  });

/** A Redis double with the four calls the service makes. */
function fakeRedis() {
  const store = new Map<string, { value: string; ttl: number }>();
  const counters = new Map<string, number>();
  return {
    store,
    get: jest.fn(async (k: string) => store.get(k)?.value ?? null),
    setex: jest.fn(async (k: string, ttl: number, value: string) => {
      store.set(k, { value, ttl });
      return 'OK';
    }),
    incr: jest.fn(async (k: string) => {
      const n = (counters.get(k) ?? 0) + 1;
      counters.set(k, n);
      return n;
    }),
    expire: jest.fn(async () => 1),
    expireAll: () => store.clear(),
  };
}

describe('Client ID Metadata Documents', () => {
  const restore = snapshotEnv(
    'MCP_CIMD_ENABLED',
    'MCP_CIMD_FETCHES_PER_HOST',
    'MCP_CIMD_CACHE_MIN_SECONDS',
    'MCP_CIMD_CACHE_MAX_SECONDS',
    'MCP_CIMD_MAX_BYTES',
    'MCP_CIMD_FETCH_TIMEOUT_MS',
    'MCP_OAUTH_INFER_APPLICATION_TYPE',
    'NODE_ENV',
  );
  afterEach(restore);

  describe('the document', () => {
    it('reads a valid document', () => {
      expect(parseCimdDocument(URL_ID, docFor({ client_uri: 'https://client.example.com', logo_uri: 'https://client.example.com/l.png' }))).toEqual({
        clientId: URL_ID,
        clientName: 'Example Client',
        clientUri: 'https://client.example.com',
        logoUri: 'https://client.example.com/l.png',
        redirectUris: ['http://127.0.0.1:33418/callback'],
        grantTypes: ['authorization_code', 'refresh_token'],
        applicationType: 'native',
      });
    });

    it.each([
      ['a client_id that is not exactly the URL', docFor({ client_id: `${URL_ID}?x=1` }), /does not match its URL/],
      ['a missing client_name', docFor({ client_name: undefined }), /client_name is required/],
      ['no redirect_uris', docFor({ redirect_uris: [] }), /redirect_uris is required/],
      ['a confidential client', docFor({ token_endpoint_auth_method: 'private_key_jwt' }), /not supported/],
      ['a client secret method', docFor({ token_endpoint_auth_method: 'client_secret_basic' }), /not supported/],
      ['an implicit grant', docFor({ grant_types: ['implicit'] }), /grant_types/],
      ['a token response type', docFor({ response_types: ['token'] }), /response_types/],
      ['a javascript redirect', docFor({ redirect_uris: ['javascript://localhost/%0aalert(1)'] }), /redirect_uri/],
      ['a web client with a loopback redirect in production', docFor({ application_type: 'web' }), /web client must use an https/],
      ['an unknown application_type', docFor({ application_type: 'desktop' }), /application_type/],
      ['not JSON', '<html>', /not JSON/],
      ['a JSON array', '[]', /not a JSON object/],
      ['an http logo', docFor({ logo_uri: 'http://client.example.com/l.png' }), /logo_uri/],
    ])('refuses %s', (_label, body, reason) => {
      process.env.NODE_ENV = 'production';
      expect(() => parseCimdDocument(URL_ID, body)).toThrow(reason);
    });

    it('lets a native client claim a private-use scheme, and a web client only https', () => {
      process.env.NODE_ENV = 'production';
      expect(parseCimdDocument(URL_ID, docFor({ application_type: 'native', redirect_uris: ['cursor://anysphere.cursor-mcp/oauth/callback'] })).redirectUris).toHaveLength(1);
      expect(() => parseCimdDocument(URL_ID, docFor({ application_type: 'web', redirect_uris: ['cursor://x/cb'] }))).toThrow();
      expect(parseCimdDocument(URL_ID, docFor({ application_type: 'web', redirect_uris: ['https://app.example.com/cb'] })).applicationType).toBe('web');
    });

    it('caches for max-age, inside the configured floor and ceiling', () => {
      const settings = { ...cimdSettings(), cacheMinSeconds: 300, cacheMaxSeconds: 86_400 };
      expect(cimdCacheSeconds('public, max-age=3600', settings)).toBe(3600);
      expect(cimdCacheSeconds('max-age=5', settings)).toBe(300);
      expect(cimdCacheSeconds('max-age=999999999', settings)).toBe(86_400);
      expect(cimdCacheSeconds('no-store', settings)).toBe(300);
      expect(cimdCacheSeconds(null, settings)).toBe(300);
    });
  });

  describe('the service', () => {
    let clients: ReturnType<typeof fakeRepository<any>>;
    let redis: ReturnType<typeof fakeRedis>;
    let fetcher: jest.Mock<Promise<CimdFetchResult>, [string, any]>;
    let service: McpOAuthCimdService;

    beforeEach(() => {
      clients = fakeRepository<any>({ idPrefix: 'client' });
      redis = fakeRedis();
      fetcher = jest.fn(async (_url: string, _limits: any): Promise<CimdFetchResult> => ({ status: 200, cacheControl: 'max-age=600', body: docFor() }));
      service = new McpOAuthCimdService(clients as any, redis as any, fetcher);
    });

    it('stores the client keyed by its URL, owned by no organization', async () => {
      const client = await service.resolveClient(URL_ID);
      expect(client).toMatchObject({
        clientId: URL_ID,
        clientName: 'Example Client',
        isMetadataDocument: true,
        organizationId: null,
        gatewayId: null,
        applicationType: 'native',
        tokenEndpointAuthMethod: 'none',
      });
      expect(clients.rows()).toHaveLength(1);
      expect(fetcher).toHaveBeenCalledWith(URL_ID, { timeoutMs: 5000, maxBytes: 65_536 });
    });

    it('serves a cached document without fetching, and updates the same row after a refresh', async () => {
      await service.resolveClient(URL_ID);
      await service.resolveClient(URL_ID);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(redis.setex.mock.calls[0][1]).toBe(600);

      redis.expireAll();
      fetcher.mockResolvedValueOnce({ status: 200, cacheControl: null, body: docFor({ client_name: 'Renamed' }) });
      const refreshed = await service.resolveClient(URL_ID);
      expect(refreshed.clientName).toBe('Renamed');
      expect(clients.rows()).toHaveLength(1);
    });

    it('refuses an expired entry whose refresh fails', async () => {
      await service.resolveClient(URL_ID);
      redis.expireAll();
      fetcher.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
      await expect(service.resolveClient(URL_ID)).rejects.toThrow(/could not be fetched/);
      fetcher.mockResolvedValueOnce({ status: 404, cacheControl: null, body: 'nope' });
      await expect(service.resolveClient(URL_ID)).rejects.toThrow(/HTTP 404/);
    });

    it('rate-limits fetches per host (MCP_CIMD_FETCHES_PER_HOST)', async () => {
      process.env.MCP_CIMD_FETCHES_PER_HOST = '2';
      const other = (n: number) => `https://client.example.com/c${n}.json`;
      fetcher.mockImplementation(async (url: string) => ({ status: 200, cacheControl: null, body: docFor({ client_id: url }) }));
      await service.resolveClient(other(1));
      await service.resolveClient(other(2));
      await expect(service.resolveClient(other(3))).rejects.toThrow(/too many client metadata fetches/);
      expect(fetcher).toHaveBeenCalledTimes(2);
      // Another host has its own budget.
      fetcher.mockResolvedValueOnce({ status: 200, cacheControl: null, body: docFor({ client_id: 'https://other.example.org/c.json' }) });
      await expect(service.resolveClient('https://other.example.org/c.json')).resolves.toBeDefined();
    });

    it('refuses when MCP_CIMD_ENABLED=false', async () => {
      process.env.MCP_CIMD_ENABLED = 'false';
      await expect(service.resolveClient(URL_ID)).rejects.toThrow(/not accepted/);
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('refuses a disabled client and never adopts a registered client id', async () => {
      clients.seed({ clientId: URL_ID, isMetadataDocument: false, isActive: true, redirectUris: [] });
      await expect(service.resolveClient(URL_ID)).rejects.toThrow(/already registered/);
    });

    it('refuses a client_id that is not a metadata URL', async () => {
      for (const id of ['mcp_client_abc', 'http://client.example.com/c.json', 'https://client.example.com/', 'https://u:p@client.example.com/c.json']) {
        await expect(service.resolveClient(id)).rejects.toThrow();
      }
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('is the client an authorization on any gateway names, and its codes bind to that gateway', async () => {
      const codes = fakeRepository<any>({ idPrefix: 'code' });
      const oauth = new McpOAuthService(clients as any, codes as any, {} as any, service);
      const consent = await oauth.getConsentInfo(URL_ID, 'gw-1', 'http://127.0.0.1:33418/callback', undefined);
      expect(consent.clientName).toBe('Example Client');
      expect(consent.clientHost).toBe('client.example.com');

      await oauth.createAuthorizationCode(URL_ID, 'u-1', 'gw-2', 'org-2', {
        redirectUri: 'http://127.0.0.1:33418/callback',
        codeChallenge: 'x'.repeat(43),
        codeChallengeMethod: 'S256',
      });
      expect(codes.rows()[0]).toMatchObject({ clientId: URL_ID, gatewayId: 'gw-2', organizationId: 'org-2' });

      await expect(
        oauth.createAuthorizationCode(URL_ID, 'u-1', 'gw-2', 'org-2', {
          redirectUri: 'http://127.0.0.1:9/elsewhere',
          codeChallenge: 'x'.repeat(43),
          codeChallengeMethod: 'S256',
        }),
      ).rejects.toThrow(/redirect_uri/);

      // The token endpoint finds the same row on any gateway.
      await expect(findGatewayClient(clients as any, URL_ID, 'gw-9')).resolves.toMatchObject({ clientId: URL_ID });
      await expect(findGatewayClient(clients as any, 'mcp_client_unknown', 'gw-9')).resolves.toBeNull();
    });
  });

  /**
   * SSRF: the metadata URL comes from an anonymous browser redirect. The
   * real fetcher refuses every internal target before a socket to it opens.
   */
  describe('the fetch, behind the SSRF guard', () => {
    let server: net.Server;
    let port: number;
    let connections = 0;

    beforeAll(async () => {
      server = net.createServer((socket) => {
        connections += 1;
        socket.destroy();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as AddressInfo).port;
    });
    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const limits = { timeoutMs: 2000, maxBytes: 65_536 };

    it.each([
      ['loopback', () => `https://127.0.0.1:${port}/client.json`],
      ['a name that resolves to loopback', () => `https://localhost:${port}/client.json`],
      ['IPv6 loopback', () => `https://[::1]:${port}/client.json`],
      ['the cloud metadata address', () => 'https://169.254.169.254/latest/meta-data/client.json'],
      ['link-local', () => 'https://169.254.10.10/client.json'],
      ['a private network', () => 'https://10.0.0.5/client.json'],
      ['a decimal-encoded loopback', () => `https://2130706433:${port}/client.json`],
      ['an IPv4-mapped IPv6 loopback', () => `https://[::ffff:127.0.0.1]:${port}/client.json`],
    ])('refuses %s without connecting', async (_label, url) => {
      const before = connections;
      await expect(safeCimdFetcher(url(), limits)).rejects.toBeDefined();
      expect(connections).toBe(before);
    });

    it('is not relaxed by MCP_ALLOW_PRIVATE_URLS', async () => {
      const restoreFlag = snapshotEnv('MCP_ALLOW_PRIVATE_URLS');
      process.env.MCP_ALLOW_PRIVATE_URLS = 'true';
      try {
        const before = connections;
        await expect(safeCimdFetcher(`https://127.0.0.1:${port}/client.json`, limits)).rejects.toBeDefined();
        expect(connections).toBe(before);
      } finally {
        restoreFlag();
      }
    });

    it('turns an oversized or slow document into a refusal, not a hang', async () => {
      const clients = fakeRepository<any>({ idPrefix: 'client' });
      const tooBig = new McpOAuthCimdService(clients as any, fakeRedis() as any, async () => {
        throw new Error('response exceeds 65536 bytes');
      });
      await expect(tooBig.resolveClient(URL_ID)).rejects.toThrow(/could not be fetched/);
      expect(clients.rows()).toHaveLength(0);
    });
  });
});
