import { mcpAllowedOrigins, mcpOriginRefusal, mcpOutcomeOf, resolveMcpRequestVersion } from '../mcp-http-binding';
import { snapshotEnv } from '../../../../test/env';

describe('MCP HTTP binding', () => {
  const restore = snapshotEnv('BASE_URL', 'FRONTEND_URL', 'MCP_ALLOWED_ORIGINS', 'MCP_PROTOCOL_VERSIONS', 'NODE_ENV', 'CORS_ALLOWED_ORIGINS');
  beforeEach(() => {
    process.env.BASE_URL = 'https://api.example.com';
    process.env.FRONTEND_URL = 'https://app.example.com';
    process.env.NODE_ENV = 'production';
    delete process.env.MCP_ALLOWED_ORIGINS;
    delete process.env.MCP_PROTOCOL_VERSIONS;
    delete process.env.CORS_ALLOWED_ORIGINS;
  });
  afterEach(restore);

  describe('Origin', () => {
    const check = (origin?: string, host = 'api.example.com') =>
      mcpOriginRefusal({ headers: { ...(origin !== undefined ? { origin } : {}), host } });

    it('lets a request without Origin through (server-to-server, curl, the stdio proxy)', () => {
      expect(check()).toBeNull();
    });

    it('allows the dashboard and the API itself', () => {
      expect(check('https://app.example.com')).toBeNull();
      expect(check('https://api.example.com')).toBeNull();
    });

    it('refuses any other origin with 403 and an id-less JSON-RPC error', () => {
      expect(check('https://evil.example.com')).toEqual({
        status: 403,
        body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Forbidden: Origin not allowed' } },
      });
    });

    // DNS rebinding: the attacker's page is served from evil.example.com,
    // which resolves to the server, so Host and Origin agree. Matching the
    // Origin against the request's Host would let it through.
    it('does not trust an Origin just because it matches the Host header', () => {
      expect(check('http://evil.example.com', 'evil.example.com')?.status).toBe(403);
    });

    it('refuses Origin: null', () => {
      expect(check('null')?.status).toBe(403);
    });

    it('takes extra origins from MCP_ALLOWED_ORIGINS', () => {
      process.env.MCP_ALLOWED_ORIGINS = 'https://inspector.example.com, https://tools.example.com/';
      expect(mcpAllowedOrigins().has('https://inspector.example.com')).toBe(true);
      expect(check('https://tools.example.com')).toBeNull();
    });

    it('allows the local MCP Inspector outside production only', () => {
      expect(check('http://localhost:6274')?.status).toBe(403);
      process.env.NODE_ENV = 'development';
      expect(check('http://localhost:6274')).toBeNull();
    });
  });

  describe('protocol version', () => {
    const resolve = (headers: Record<string, string>, body: unknown) => resolveMcpRequestVersion({ headers }, body);
    const call = { jsonrpc: '2.0', id: 7, method: 'tools/list' };

    it('negotiates on initialize, whatever header is sent', () => {
      expect(
        resolve({ 'mcp-protocol-version': '1999-01-01' }, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
      ).toEqual({ ctx: { version: '2025-06-18', era: 'legacy' } });
    });

    it('assumes 2025-03-26 without a header', () => {
      expect(resolve({}, call)).toEqual({ ctx: { version: '2025-03-26', era: 'assumed' } });
    });

    it.each(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'])('serves %s when the header names it', (version) => {
      expect(resolve({ 'mcp-protocol-version': version }, call)).toEqual({ ctx: { version, era: 'legacy' } });
    });

    it('refuses an unknown or malformed version with 400, keeping the request id', () => {
      const out: any = resolve({ 'mcp-protocol-version': 'next-tuesday' }, call);
      expect(out.refusal.status).toBe(400);
      expect(out.refusal.body.id).toBe(7);
      expect(out.refusal.body.error.code).toBe(-32600);
      expect(out.refusal.body.error.data.supported).toContain('2025-11-25');
    });

    it('refuses a version taken out of MCP_PROTOCOL_VERSIONS', () => {
      process.env.MCP_PROTOCOL_VERSIONS = '2025-11-25,2025-06-18';
      expect((resolve({ 'mcp-protocol-version': '2024-11-05' }, call) as any).refusal.status).toBe(400);
    });

    it('refuses a batch with 400 from 2025-06-18 on', () => {
      const batch = [call, { ...call, id: 8 }];
      expect((resolve({ 'mcp-protocol-version': '2025-06-18' }, batch) as any).refusal.status).toBe(400);
      expect((resolve({ 'mcp-protocol-version': '2025-11-25' }, batch) as any).refusal.status).toBe(400);
      expect(resolve({ 'mcp-protocol-version': '2025-03-26' }, batch)).toEqual({ ctx: { version: '2025-03-26', era: 'legacy' } });
      expect(resolve({}, batch)).toEqual({ ctx: { version: '2025-03-26', era: 'assumed' } });
    });
  });

  it('classifies an answer for the request log', () => {
    expect(mcpOutcomeOf(null)).toBe('notification');
    expect(mcpOutcomeOf({ jsonrpc: '2.0', id: 1, result: {} })).toBe('ok');
    expect(mcpOutcomeOf({ jsonrpc: '2.0', id: 1, result: { isError: true } })).toBe('tool_error');
    expect(mcpOutcomeOf({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'x' } })).toBe('error');
  });
});
