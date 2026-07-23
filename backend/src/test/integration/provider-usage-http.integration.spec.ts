/**
 * REAL HTTP round-trip for the OpenAI provider-usage ingestion path (#241).
 *
 * The unit spec (provider-usage/__tests__/provider-usage.service.spec.ts) mocks
 * the `fetchJson` seam, so the real global `fetch`, the Authorization header,
 * the query-string construction (start_time/end_time/bucket_width), the
 * non-2xx error mapping, and the usage+costs bucket merge are never exercised
 * end to end over a socket.
 *
 * #241 is best-verified against a real OpenAI Admin account; a full emulator
 * of the OpenAI usage API adds little. But a genuinely-cheap local HTTP server
 * standing in for the two OpenAI org endpoints lets us drive the UNMOCKED
 * fetch path once — proving the request the app builds is well-formed and the
 * spec-shaped response parses. No Docker; just a loopback http.Server.
 *
 * Gated behind RUN_EMULATOR_TESTS=1 (binds a loopback port); skipped otherwise.
 */
import * as http from 'http';
import { AddressInfo } from 'net';

import { ProviderUsageService } from '../../modules/provider-usage/provider-usage.service';
import {
  LlmProvider,
  LlmProviderType,
} from '../../entities/llm-provider.entity';

const RUN = process.env.RUN_EMULATOR_TESTS === '1';
const d = RUN ? describe : describe.skip;

const ADMIN_KEY = 'sk-admin-usage-key';

/** Envelope stub — warmOrg is a no-op for a non-KMS org. */
const envelopeStub = { warmOrg: async () => undefined } as any;

function makeProvider(apiUrl: string): LlmProvider {
  const p = new LlmProvider();
  p.id = 'prov-1';
  p.organizationId = 'org-usage-1';
  p.type = LlmProviderType.OPENAI;
  p.configuration = { apiUrl } as any;
  // Real decrypt accessors the service calls; return the admin usage key.
  (p as any).getDecryptedUsageApiKey = () => ADMIN_KEY;
  (p as any).getDecryptedApiKey = () => 'sk-inference-key';
  return p;
}

d('Provider usage — real HTTP round-trip vs a stand-in OpenAI usage API', () => {
  jest.setTimeout(20_000);

  let server: http.Server;
  let baseUrl: string;
  let service: ProviderUsageService;
  const requests: Array<{ url: string; auth: string | undefined }> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      requests.push({
        url: req.url || '',
        auth: req.headers.authorization,
      });
      res.setHeader('Content-Type', 'application/json');
      const url = req.url || '';
      if (url.includes('/force-404/')) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not found' }));
      } else if (url.includes('/organization/usage/completions')) {
        res.end(
          JSON.stringify({
            data: [
              {
                start_time: 1704067200, // 2024-01-01T00:00:00Z
                end_time: 1704153600,
                results: [
                  { input_tokens: 1000, output_tokens: 400 },
                ],
              },
            ],
          }),
        );
      } else if (url.includes('/organization/costs')) {
        res.end(
          JSON.stringify({
            data: [
              {
                start_time: 1704067200,
                end_time: 1704153600,
                results: [{ amount: { value: 2.5, currency: 'usd' } }],
              },
            ],
          }),
        );
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not found' }));
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;

    service = new ProviderUsageService(
      {} as any, // snapshotRepo — unused by fetchProviderUsage
      {} as any, // providerRepo — unused
      {} as any, // conversationRepo — unused
      envelopeStub,
    );
  });

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  it('builds an authenticated request and parses merged usage+cost buckets', async () => {
    const provider = makeProvider(baseUrl);
    const from = new Date('2024-01-01T00:00:00Z');
    const to = new Date('2024-01-02T00:00:00Z');

    const result = await service.fetchProviderUsage(provider, from, to);

    expect(result.supported).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.buckets).toHaveLength(1);

    const bucket = result.buckets[0];
    expect(bucket.inputTokens).toBe(1000);
    expect(bucket.outputTokens).toBe(400);
    expect(bucket.totalTokens).toBe(1400);
    // $2.50 -> 250 cents.
    expect(bucket.costCents).toBe(250);

    // Both org endpoints were actually hit over the socket, with the admin key
    // and the correct 1-day bucket query params.
    expect(requests).toHaveLength(2);
    for (const req of requests) {
      expect(req.auth).toBe(`Bearer ${ADMIN_KEY}`);
      expect(req.url).toContain('bucket_width=1d');
      expect(req.url).toContain('start_time=');
      expect(req.url).toContain('end_time=');
    }
    expect(
      requests.some((r) => r.url.includes('/organization/usage/completions')),
    ).toBe(true);
    expect(requests.some((r) => r.url.includes('/organization/costs'))).toBe(
      true,
    );
  });

  it('maps a non-2xx usage response to a surfaced error, not a throw', async () => {
    // Point at a path the stub 404s so fetchJson raises; fetchProviderUsage
    // must catch and return the error field rather than reject.
    const provider = makeProvider(`${baseUrl}/force-404`);
    const result = await service.fetchProviderUsage(
      provider,
      new Date('2024-01-01T00:00:00Z'),
      new Date('2024-01-02T00:00:00Z'),
    );
    expect(result.supported).toBe(true);
    expect(result.buckets).toEqual([]);
    expect(result.error).toMatch(/HTTP 404/);
  });
});
