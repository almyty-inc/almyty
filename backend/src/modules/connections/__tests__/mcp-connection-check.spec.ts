import { ConnectionValidationService } from '../connection-validation.service';
import { ssrfSafeDispatcher } from '../../../common/security/safe-fetch';
import { snapshotEnv } from '../../../test/env';

/**
 * The "MCP server" connection check connects the way an MCP source does
 * (McpClientService: server/discover first, initialize as the fallback), on
 * the check's own pinned transport.
 */
describe('MCP connection check', () => {
  const restore = snapshotEnv('MCP_CLIENT_ERA', 'MCP_ALLOW_PRIVATE_URLS');
  afterEach(restore);

  const connector = { key: 'mcp-custom', displayName: 'MCP server', validation: { kind: 'mcp_initialize' } } as any;
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  function check(handler: (method: string, body: any, init: any) => Response) {
    const calls: Array<{ method: string; init: any }> = [];
    const http = jest.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push({ method: body.method, init });
      return handler(body.method, body, init);
    });
    const service = new ConnectionValidationService({ get: (k: string) => process.env[k] } as any, http);
    return { run: (config: Record<string, any>) => service.validate(connector, config, { organizationId: 'o' }), calls };
  }

  it('is valid for a 2026-07-28 server, named after what it calls itself', async () => {
    const { run, calls } = check((_m, body) =>
      json({ jsonrpc: '2.0', id: body.id, result: { supportedVersions: ['2026-07-28'], capabilities: {}, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'linear', title: 'Linear', version: '1' } } } }),
    );
    const result = await run({ serverUrl: 'https://mcp.linear.example/mcp', apiKey: 'lin_123' });
    expect(result).toEqual({ ok: true, status: 'valid', accountLabel: 'Linear' });
    expect(calls.map((c) => c.method)).toEqual(['server/discover']);
    expect(calls[0].init.headers.Authorization).toBe('Bearer lin_123');
    expect(calls[0].init.dispatcher).toBe(ssrfSafeDispatcher);
  });

  it('is valid for a legacy server, through initialize', async () => {
    const { run, calls } = check((method, body) => {
      if (method === 'server/discover') return json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Bad Request: No valid session ID provided' } }, 400);
      if (method === 'initialize') return json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'old-server', version: '1' } } }, 200, { 'mcp-session-id': 's' });
      return new Response(null, { status: 202 });
    });
    expect(await run({ serverUrl: 'https://mcp.example.com/mcp' })).toEqual({ ok: true, status: 'valid', accountLabel: 'old-server' });
    expect(calls.map((c) => c.method)).toEqual(['server/discover', 'initialize', 'notifications/initialized']);
  });

  it('reports a refused key as a refused credential', async () => {
    const { run } = check(() => new Response('unauthorized', { status: 401 }));
    expect(await run({ serverUrl: 'https://mcp.example.com/mcp', apiKey: 'bad' })).toMatchObject({ ok: false, status: 'failed', error: expect.stringContaining('rejected the credential (401') });
  });

  it('refuses a private URL before sending anything', async () => {
    const { run, calls } = check(() => json({}));
    expect(await run({ serverUrl: 'http://10.0.0.5/mcp' })).toMatchObject({ ok: false, error: expect.stringContaining('server URL refused') });
    expect(calls).toHaveLength(0);
  });
});
