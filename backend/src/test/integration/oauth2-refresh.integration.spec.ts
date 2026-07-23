/**
 * Real-HTTP integration spec for the OAuth2 refresh flow in
 * CredentialService.
 *
 * The existing credential.service.spec.ts mocks axios at the module
 * level with `jest.mock('axios', ...)` and asserts the mock was
 * called with a specific payload. That proves the test mirrors the
 * shape of the code; it does NOT prove that the real refresh flow
 * — form-encoded body, x-www-form-urlencoded Content-Type header,
 * response parsing, refresh_token rotation handling, expires_in
 * computation, error side-effect (marking the credential inactive),
 * or the concurrent-refresh lock — actually work. A bug in any of
 * those paths would pass the mocked tests and then reveal itself
 * in production the first time a real OAuth server was contacted.
 *
 * This spec stands up a tiny HTTP server on 127.0.0.1, points the
 * real (unmocked) axios at it through CredentialService.refreshOAuthToken,
 * and verifies the whole round-trip. The validateUrl SSRF guard
 * (which correctly refuses 127.0.0.1 by default) is stubbed to
 * accept the loopback URL for this one spec — its own unit tests
 * cover the refusal path separately.
 */
jest.unmock('axios');
jest.mock('../../common/security/url-validator', () => ({
  validateUrl: (url: string) => ({ valid: true, normalized: url }),
}));

import * as http from 'http';
import { AddressInfo } from 'net';
import { BadRequestException } from '@nestjs/common';

import { CredentialService } from '../../modules/apis/credential.service';
import { Credential, CredentialType } from '../../entities/credential.entity';
import { makeEnvelopeCryptoMock } from '../envelope-crypto.mock';

jest.setTimeout(20_000);

// ── Tiny OAuth2 refresh server — scripted per-test ───────────────

interface ServerScript {
  /**
   * Handler invoked for each incoming request. The test assigns
   * this per-case via `currentScript = …` so behaviour can vary
   * without restarting the server.
   */
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;
}

describe('CredentialService.refreshOAuthToken — real HTTP round trip', () => {
  let server: http.Server;
  let tokenEndpoint: string;
  let currentScript: ServerScript;
  let requestLog: Array<{ method: string; url: string; headers: any; body: string }> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        requestLog.push({
          method: req.method!,
          url: req.url!,
          headers: req.headers,
          body,
        });
        currentScript.handler(req, res, body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    tokenEndpoint = `http://127.0.0.1:${addr.port}/oauth/token`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  beforeEach(() => {
    requestLog = [];
    // Default script: return a fresh access token with 1h expiry.
    currentScript = {
      handler: (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: 'new-access-token',
            expires_in: 3600,
          }),
        );
      },
    };
  });

  // ─── Test harness: build a CredentialService + a fake Credential ──

  function buildHarness(initialCredConfig: Record<string, any>): {
    service: CredentialService;
    credRow: Credential;
    savedRows: Credential[];
  } {
    const savedRows: Credential[] = [];

    // Build a real Credential instance so encryptSensitiveData,
    // getDecryptedConfig, getAuthHeaders etc. all run against the
    // actual entity methods.
    const credRow = new Credential();
    Object.assign(credRow, {
      id: 'cred-1',
      name: 'OAuth Test Credential',
      type: CredentialType.OAUTH2,
      organizationId: 'org-1',
      apiId: 'api-1',
      keyLocation: 'header',
      isActive: true,
      expiresAt: new Date(Date.now() - 60_000), // expired 60s ago
      scopes: null,
      config: initialCredConfig,
    });

    const credentialRepo: any = {
      findOne: jest.fn().mockImplementation(async () => credRow),
      save: jest.fn().mockImplementation(async (c: Credential) => {
        savedRows.push(c);
        return c;
      }),
    };
    const apiRepo: any = {
      findOne: jest.fn().mockResolvedValue({ id: 'api-1', baseUrl: 'https://example.com' }),
    };

    const service = new CredentialService(credentialRepo, apiRepo, makeEnvelopeCryptoMock());
    return { service, credRow, savedRows };
  }

  // ── Happy path: refresh returns new access token ────────────

  it('POSTs form-encoded body and updates accessToken from the response', async () => {
    const { service, credRow, savedRows } = buildHarness({
      tokenEndpoint,
      clientId: 'client-abc',
      clientSecret: 'secret-xyz',
      refreshToken: 'initial-refresh-token',
      accessToken: 'stale-access-token',
    });

    const refreshed = await service.refreshOAuthToken(credRow);

    // One POST to the token endpoint, with the expected shape.
    expect(requestLog).toHaveLength(1);
    const logged = requestLog[0];
    expect(logged.method).toBe('POST');
    expect(logged.url).toBe('/oauth/token');
    expect(logged.headers['content-type']).toBe('application/x-www-form-urlencoded');

    // Body is form-encoded — parse and pin the fields.
    const parsed = new URLSearchParams(logged.body);
    expect(parsed.get('grant_type')).toBe('refresh_token');
    expect(parsed.get('refresh_token')).toBe('initial-refresh-token');
    expect(parsed.get('client_id')).toBe('client-abc');
    expect(parsed.get('client_secret')).toBe('secret-xyz');

    // The credential's config is updated with the new access token
    // (and the refresh token is retained since the server didn't
    // return a new one).
    const config = refreshed.getDecryptedConfig();
    expect(config.accessToken).toBe('new-access-token');
    expect(config.refreshToken).toBe('initial-refresh-token');

    // expiresAt is set to now + 3600s (within a small tolerance).
    const expectedExpiry = Date.now() + 3_600_000;
    expect(refreshed.expiresAt!.getTime()).toBeGreaterThan(expectedExpiry - 5_000);
    expect(refreshed.expiresAt!.getTime()).toBeLessThan(expectedExpiry + 5_000);

    // Row was saved.
    expect(savedRows).toHaveLength(1);
  });

  // ── Refresh token rotation ───────────────────────────────────

  it('rotates the refresh token when the server returns a new one', async () => {
    currentScript = {
      handler: (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: 'new-access-token',
            refresh_token: 'rotated-refresh-token',
            expires_in: 3600,
          }),
        );
      },
    };

    const { service, credRow } = buildHarness({
      tokenEndpoint,
      clientId: 'client-abc',
      clientSecret: 'secret-xyz',
      refreshToken: 'initial-refresh-token',
    });

    const refreshed = await service.refreshOAuthToken(credRow);

    const config = refreshed.getDecryptedConfig();
    expect(config.refreshToken).toBe('rotated-refresh-token');
    expect(config.accessToken).toBe('new-access-token');
  });

  // ── Error: server returns 4xx → mark credential inactive ───

  it('marks the credential inactive when the server returns an error', async () => {
    currentScript = {
      handler: (_req, res) => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant' }));
      },
    };

    const { service, credRow, savedRows } = buildHarness({
      tokenEndpoint,
      clientId: 'client-abc',
      clientSecret: 'secret-xyz',
      refreshToken: 'expired-refresh-token',
    });

    await expect(service.refreshOAuthToken(credRow)).rejects.toThrow(BadRequestException);

    // The credential was saved with isActive=false.
    expect(savedRows).toHaveLength(1);
    expect(savedRows[0].isActive).toBe(false);
  });

  // ── Concurrent-refresh debouncing ────────────────────────────

  it('debounces two concurrent refresh calls into a single HTTP request', async () => {
    // Force the server to hold the first response so we can fire
    // a second call before the first completes. The test proves
    // the refreshLocks map correctly returns the in-flight promise
    // to the second caller.
    let release: (() => void) | undefined;
    const hold = new Promise<void>((r) => (release = r));
    currentScript = {
      handler: async (_req, res) => {
        await hold;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: 'concurrent-access-token',
            expires_in: 3600,
          }),
        );
      },
    };

    const { service, credRow } = buildHarness({
      tokenEndpoint,
      clientId: 'client-abc',
      clientSecret: 'secret-xyz',
      refreshToken: 'initial-refresh-token',
    });

    // Fire two concurrent refreshes. The lock map should short-
    // circuit the second to reuse the first's promise.
    const p1 = service.refreshOAuthToken(credRow);
    const p2 = service.refreshOAuthToken(credRow);
    release!();
    const [r1, r2] = await Promise.all([p1, p2]);

    // The server should have seen exactly ONE request even though
    // we called refresh twice. If the lock map is broken, the
    // second call would have hit the server again and requestLog
    // would have length 2.
    expect(requestLog).toHaveLength(1);
    expect(r1).toBe(r2); // same resolved credential object
  });

  // ── Early return: already-refreshed-by-another-process ──────

  it('skips the network call if the credential was already refreshed by another process', async () => {
    // Stage a credential whose expiresAt is still well in the future
    // — simulating another backend instance that refreshed ours out
    // of band. refreshOAuthTokenInternal should return early without
    // hitting the token endpoint.
    const { service, credRow } = buildHarness({
      tokenEndpoint,
      clientId: 'client-abc',
      clientSecret: 'secret-xyz',
      refreshToken: 'initial-refresh-token',
      accessToken: 'still-valid-access-token',
    });
    credRow.expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2h in future

    const result = await service.refreshOAuthToken(credRow);
    expect(result).toBe(credRow);
    expect(requestLog).toHaveLength(0);
  });

  // ── Non-OAuth2 credential types are refused ─────────────────

  it('rejects non-OAuth2 credentials with BadRequestException', async () => {
    const { service, credRow } = buildHarness({});
    credRow.type = CredentialType.API_KEY;

    await expect(service.refreshOAuthToken(credRow)).rejects.toThrow(BadRequestException);
    expect(requestLog).toHaveLength(0);
  });

  // ── Missing config fields are refused ───────────────────────

  it('rejects credentials missing refreshToken or tokenEndpoint', async () => {
    const { service, credRow } = buildHarness({
      tokenEndpoint,
      clientId: 'client-abc',
      clientSecret: 'secret-xyz',
      // no refreshToken
    });

    await expect(service.refreshOAuthToken(credRow)).rejects.toThrow(BadRequestException);
    expect(requestLog).toHaveLength(0);
  });
});
