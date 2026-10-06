import { EventEmitter } from 'events';

import { McpSurface, handleSingleMessage } from '../mcp-protocol-core';
import {
  decodeMcpHeaderValue,
  mcpHttpStatusOf,
  resolveMcpRequestVersion,
  traceFromMeta,
} from '../mcp-http-binding';
import { mcpParamHeaderMismatch } from '../mcp-param-headers';
import { acknowledgedFilter, serveSubscriptionListen } from '../mcp-listen';
import { scopesForMcpMessage } from '../../services/mcp-oauth-scope';
import { McpChangeBus } from '../../../mcp-events/mcp-change-bus.service';
import { snapshotEnv } from '../../../../test/env';

/**
 * MCP 2026-07-28 ("modern"): per-request _meta, the mirrored headers,
 * server/discover, resultType and serverInfo, caching hints, the methods a
 * modern request may not use, Mcp-Param-* headers, trace context and
 * subscriptions/listen.
 */
const V = '2026-07-28';
const meta = (over: Record<string, unknown> = {}) => ({
  'io.modelcontextprotocol/protocolVersion': V,
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '9.9' },
  ...over,
});
const modernHeaders = (method: string, name?: string, extra: Record<string, string> = {}) => ({
  'mcp-protocol-version': V,
  'mcp-method': method,
  ...(name !== undefined ? { 'mcp-name': name } : {}),
  ...extra,
});
const modern = { version: V as any, era: 'modern' as const, clientCapabilities: {} };

function surface(over: Partial<McpSurface> = {}): McpSurface {
  return {
    serverInfo: () => ({ name: 'petstore', version: '1.0.0', title: 'Petstore' }),
    capabilities: () => ({ tools: { listChanged: false }, logging: {}, prompts: { listChanged: false } }),
    instructions: () => 'Pets.',
    listTools: async () => ({ tools: [{ name: 'list_pets', inputSchema: { type: 'object' } }] }),
    callTool: async () => ({ content: [{ type: 'text', text: '[1,2]' }], structuredContent: [1, 2], isError: false }),
    toolsChangedChannel: () => 'mcp:changed:gw-1',
    ...over,
  };
}

describe('MCP 2026-07-28', () => {
  const restore = snapshotEnv('MCP_RESULT_TTL_MS', 'MCP_LISTEN_KEEPALIVE_MS', 'MCP_LISTEN_MAX_SECONDS', 'MCP_PROTOCOL_VERSIONS');
  afterEach(restore);

  describe('resolving a modern request', () => {
    const body = (method: string, params: Record<string, unknown> = {}, id: unknown = 1) => ({
      jsonrpc: '2.0',
      id,
      method,
      params: { ...params, _meta: meta() },
    });

    it('serves it statelessly with what _meta declared', () => {
      const out: any = resolveMcpRequestVersion(
        { headers: modernHeaders('tools/list') },
        { ...body('tools/list'), params: { _meta: meta({ traceparent: '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01' }) } },
      );
      expect(out.ctx).toEqual({
        version: V,
        era: 'modern',
        clientCapabilities: {},
        clientInfo: { name: 'test-client', version: '9.9' },
        trace: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01' },
      });
    });

    it.each([
      ['no MCP-Protocol-Version header', { 'mcp-method': 'tools/list' }],
      ['a header that disagrees with _meta', modernHeaders('tools/list', undefined, { 'mcp-protocol-version': '2025-11-25' })],
      ['no Mcp-Method header', { 'mcp-protocol-version': V }],
      ['an Mcp-Method that differs from the body', modernHeaders('prompts/list')],
      ['an Mcp-Method in another case', modernHeaders('TOOLS/LIST')],
    ])('refuses %s with 400 and -32020, keeping the id', (_label, headers) => {
      const out: any = resolveMcpRequestVersion({ headers }, body('tools/list', {}, 'req-7'));
      expect(out.refusal.status).toBe(400);
      expect(out.refusal.body).toMatchObject({ id: 'req-7', error: { code: -32020 } });
    });

    it('accepts whitespace around header values (Node lowercases header names)', () => {
      const out: any = resolveMcpRequestVersion(
        { headers: { 'mcp-protocol-version': ` ${V} `, 'mcp-method': ' tools/call ', 'mcp-name': '  list_pets ' } },
        body('tools/call', { name: 'list_pets' }),
      );
      expect(out.ctx?.era).toBe('modern');
    });

    it('checks Mcp-Name against params.name or params.uri, decoding the Base64 sentinel', () => {
      const ok = (method: string, params: any, name: string) =>
        resolveMcpRequestVersion({ headers: modernHeaders(method, name) }, body(method, params)) as any;
      expect(ok('tools/call', { name: 'list_pets' }, 'list_pets').ctx).toBeDefined();
      expect(ok('resources/read', { uri: 'file:///a b.json' }, `=?base64?${Buffer.from('file:///a b.json').toString('base64')}?=`).ctx).toBeDefined();
      expect(ok('prompts/get', { name: 'Grüße' }, `=?base64?${Buffer.from('Grüße').toString('base64')}?=`).ctx).toBeDefined();
      expect(ok('tools/call', { name: 'list_pets' }, 'other').refusal.body.error.code).toBe(-32020);
      expect(ok('tools/call', { name: 'list_pets' }, '=?base64?bm9w!?=').refusal.body.error.code).toBe(-32020);
      const missing: any = resolveMcpRequestVersion({ headers: modernHeaders('tools/call') }, body('tools/call', { name: 'list_pets' }));
      expect(missing.refusal.body.error.code).toBe(-32020);
    });

    it('answers a version it does not serve with -32022 listing what it does', () => {
      const headers = { ...modernHeaders('tools/list'), 'mcp-protocol-version': '2027-01-01' };
      const out: any = resolveMcpRequestVersion(
        { headers },
        { jsonrpc: '2.0', id: 3, method: 'tools/list', params: { _meta: meta({ 'io.modelcontextprotocol/protocolVersion': '2027-01-01' }) } },
      );
      expect(out.refusal.status).toBe(400);
      expect(out.refusal.body.error).toEqual({
        code: -32022,
        message: 'Unsupported protocol version',
        data: { supported: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'], requested: '2027-01-01' },
      });
    });

    it('refuses 2026-07-28 when MCP_PROTOCOL_VERSIONS leaves it out', () => {
      process.env.MCP_PROTOCOL_VERSIONS = '2025-11-25,2025-06-18';
      const out: any = resolveMcpRequestVersion({ headers: modernHeaders('tools/list') }, body('tools/list'));
      expect(out.refusal.body.error.code).toBe(-32022);
    });

    it('refuses a request whose _meta lacks clientCapabilities with -32602 and 400', () => {
      const out: any = resolveMcpRequestVersion(
        { headers: modernHeaders('tools/list') },
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': V } } },
      );
      expect(out.refusal).toMatchObject({ status: 400, body: { error: { code: -32602 } } });
    });

    it('refuses a 2026-07-28 header on a request without _meta with -32602', () => {
      const out: any = resolveMcpRequestVersion({ headers: modernHeaders('tools/list') }, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      expect(out.refusal).toMatchObject({ status: 400, body: { error: { code: -32602 } } });
    });

    it('takes an initialize that carries _meta as modern, where initialize does not exist', async () => {
      const req = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', _meta: meta() } };
      const out: any = resolveMcpRequestVersion({ headers: modernHeaders('initialize') }, req);
      expect(out.ctx.era).toBe('modern');
      const res = await handleSingleMessage(req, surface(), out.ctx);
      expect(res!.error!.code).toBe(-32601);
      expect(mcpHttpStatusOf(out.ctx, res)).toBe(404);
    });

    it('decodes the sentinel strictly', () => {
      expect(decodeMcpHeaderValue('=?base64?SGVsbG8sIOS4lueVjA==?=')).toBe('Hello, 世界');
      expect(decodeMcpHeaderValue('plain value')).toBe('plain value');
      expect(decodeMcpHeaderValue('=?base64?SGVsbG8?=')).toBeNull();
      expect(decodeMcpHeaderValue('café')).toBeNull();
    });

    it('keeps a well-formed traceparent and ignores a malformed one', () => {
      expect(traceFromMeta({ traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01', tracestate: 'a=b' })).toEqual({
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        tracestate: 'a=b',
      });
      expect(traceFromMeta({ traceparent: '00-00000000000000000000000000000000-00f067aa0ba902b7-01' })).toBeUndefined();
      expect(traceFromMeta({ traceparent: 'ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' })).toBeUndefined();
      expect(traceFromMeta({ traceparent: 'not a trace' })).toBeUndefined();
    });
  });

  describe('the core, for a modern request', () => {
    it('serves server/discover with versions, capabilities and caching hints', async () => {
      process.env.MCP_RESULT_TTL_MS = '1234';
      const res: any = await handleSingleMessage({ jsonrpc: '2.0', id: 'd', method: 'server/discover', params: { _meta: meta() } }, surface(), modern);
      expect(res.result).toEqual({
        resultType: 'complete',
        supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
        capabilities: { tools: { listChanged: true }, prompts: { listChanged: false } },
        instructions: 'Pets.',
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'petstore', version: '1.0.0', title: 'Petstore' } },
        ttlMs: 1234,
        cacheScope: 'private',
      });
    });

    it('advertises tools.listChanged only on a surface with a change channel', async () => {
      const res: any = await handleSingleMessage(
        { jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} },
        surface({ toolsChangedChannel: () => null }),
        modern,
      );
      expect(res.result.capabilities.tools).toEqual({ listChanged: false });
    });

    it('puts resultType and serverInfo on every result, caching hints only on cacheable ones', async () => {
      const list: any = await handleSingleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, surface(), modern);
      expect(list.result).toMatchObject({ resultType: 'complete', ttlMs: 60000, cacheScope: 'private' });
      const call: any = await handleSingleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_pets' } }, surface(), modern);
      expect(call.result.resultType).toBe('complete');
      expect(call.result._meta['io.modelcontextprotocol/serverInfo'].name).toBe('petstore');
      expect(call.result.ttlMs).toBeUndefined();
      // Any JSON value is structuredContent in 2026-07-28.
      expect(call.result.structuredContent).toEqual([1, 2]);
    });

    it('drops an array structuredContent for a 2025-11-25 client', async () => {
      const call: any = await handleSingleMessage(
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_pets' } },
        surface(),
        { version: '2025-11-25', era: 'legacy' },
      );
      expect(call.result.structuredContent).toBeUndefined();
      expect(call.result.resultType).toBeUndefined();
    });

    it.each(['initialize', 'ping', 'logging/setLevel', 'resources/subscribe', 'tools/discover', 'skills/list', 'no/such'])(
      'answers %s with -32601, which the binding sends as 404',
      async (method) => {
        const s = surface({ extraMethods: { 'tools/discover': async () => ({}), 'skills/list': async () => ({}) } });
        const res: any = await handleSingleMessage({ jsonrpc: '2.0', id: 5, method, params: {} }, s, modern);
        expect(res).toEqual({ jsonrpc: '2.0', id: 5, error: { code: -32601, message: `Method not found: ${method}` } });
        expect(mcpHttpStatusOf(modern, res)).toBe(404);
      },
    );

    it('sends header and capability errors as 400, everything else as 200', () => {
      const err = (code: number) => ({ jsonrpc: '2.0' as const, id: 1, error: { code, message: 'x' } });
      expect(mcpHttpStatusOf(modern, err(-32020))).toBe(400);
      expect(mcpHttpStatusOf(modern, err(-32021))).toBe(400);
      expect(mcpHttpStatusOf(modern, err(-32602))).toBe(200);
      expect(mcpHttpStatusOf({ version: '2025-11-25', era: 'legacy' }, err(-32601))).toBe(200);
      expect(mcpHttpStatusOf(modern, null)).toBe(202);
    });

    it('accepts and drops a notification', async () => {
      await expect(handleSingleMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }, surface(), modern)).resolves.toBeNull();
    });
  });

  describe('Mcp-Param-* headers', () => {
    const schema = {
      type: 'object',
      properties: {
        region: { type: 'string', 'x-mcp-header': 'Region' },
        limit: { type: 'integer', 'x-mcp-header': 'Limit' },
        dryRun: { type: 'boolean', 'x-mcp-header': 'DryRun' },
        nested: { type: 'object', properties: { zone: { type: 'string', 'x-mcp-header': 'Zone' } } },
        list: { type: 'array', items: { type: 'object', properties: { ignored: { type: 'string', 'x-mcp-header': 'Ignored' } } } },
      },
    };

    it('accepts headers that agree with the arguments, numerically for numbers', () => {
      expect(
        mcpParamHeaderMismatch(schema, { region: 'us-west1', limit: 42, dryRun: true, nested: { zone: 'b' } }, {
          'mcp-param-region': 'us-west1',
          'mcp-param-limit': '42.0',
          'mcp-param-dryrun': 'true',
          'mcp-param-zone': `=?base64?${Buffer.from('b').toString('base64')}?=`,
        }),
      ).toBeNull();
    });

    it('expects no header for an absent or null argument', () => {
      expect(mcpParamHeaderMismatch(schema, { region: null }, {})).toBeNull();
    });

    it.each([
      ['a missing header', { region: 'eu' }, {}],
      ['a different value', { region: 'eu' }, { 'mcp-param-region': 'us' }],
      ['a different number', { limit: 1 }, { 'mcp-param-limit': '2' }],
      ['invalid characters', {}, { 'mcp-param-region': 'café' }],
    ])('refuses %s', (_label, args, headers) => {
      expect(mcpParamHeaderMismatch(schema, args, headers)).toMatch(/Mcp-Param-/);
    });

    it('ignores an annotation that is not reachable through properties alone', () => {
      expect(mcpParamHeaderMismatch(schema, { list: [{ ignored: 'x' }] }, {})).toBeNull();
    });
  });

  describe('OAuth scopes of the 2026 methods', () => {
    it('needs the scope of every list type a listen opts in to, and none for discover', () => {
      expect(scopesForMcpMessage({ method: 'server/discover' })).toEqual([]);
      expect(scopesForMcpMessage({ method: 'subscriptions/listen', params: { notifications: { toolsListChanged: true } } })).toEqual(['mcp:tools']);
      expect(
        scopesForMcpMessage({ method: 'subscriptions/listen', params: { notifications: { promptsListChanged: true, resourceSubscriptions: ['x'] } } }),
      ).toEqual(['mcp:prompts', 'mcp:resources']);
      expect(scopesForMcpMessage({ method: 'tools/call' })).toEqual(['mcp:tools']);
    });
  });

  describe('subscriptions/listen', () => {
    function fakeRes() {
      const events = new EventEmitter();
      const res: any = {
        writes: [] as string[],
        headers: {} as Record<string, string>,
        statusCode: 0,
        destroyed: false,
        status(code: number) { this.statusCode = code; return this; },
        setHeader(k: string, v: string) { this.headers[k] = v; },
        flushHeaders() {},
        write(chunk: string) { this.writes.push(chunk); return true; },
        end() { this.ended = true; },
        on: events.on.bind(events),
        emitClose: () => events.emit('close'),
      };
      return res;
    }
    const messages = (res: any) =>
      res.writes.filter((w: string) => w.startsWith('event:')).map((w: string) => JSON.parse(w.split('data: ')[1]));

    afterEach(() => jest.useRealTimers());

    it('acknowledges first with the subset it honours, then delivers tool changes tagged with the subscription id', async () => {
      const bus = new McpChangeBus({} as any, undefined);
      const res = fakeRes();
      serveSubscriptionListen({
        res,
        id: 'sub-1',
        params: { notifications: { toolsListChanged: true, promptsListChanged: true } },
        serverInfo: { name: 'gw', version: '1' },
        toolsGatewayId: 'gw-1',
        bus,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['Content-Type']).toBe('text/event-stream');
      expect(res.headers['X-Accel-Buffering']).toBe('no');

      await bus.gatewayToolsChanged('gw-2'); // another gateway: not delivered
      await bus.gatewayToolsChanged('gw-1');
      expect(messages(res)).toEqual([
        {
          jsonrpc: '2.0',
          method: 'notifications/subscriptions/acknowledged',
          params: { _meta: { 'io.modelcontextprotocol/subscriptionId': 'sub-1' }, notifications: { toolsListChanged: true } },
        },
        {
          jsonrpc: '2.0',
          method: 'notifications/tools/list_changed',
          params: { _meta: { 'io.modelcontextprotocol/subscriptionId': 'sub-1' } },
        },
      ]);

      res.emitClose();
      expect(bus.listenerCount('gw-1')).toBe(0);
    });

    it('sends nothing the client did not ask for', async () => {
      const bus = new McpChangeBus({} as any, undefined);
      const res = fakeRes();
      serveSubscriptionListen({ res, id: 2, params: { notifications: {} }, serverInfo: { name: 'gw', version: '1' }, toolsGatewayId: 'gw-1', bus });
      await bus.gatewayToolsChanged('gw-1');
      expect(messages(res)).toHaveLength(1);
      expect(messages(res)[0].params.notifications).toEqual({});
      res.emitClose();
    });

    it('keeps the stream alive and ends it gracefully after MCP_LISTEN_MAX_SECONDS', () => {
      jest.useFakeTimers();
      process.env.MCP_LISTEN_KEEPALIVE_MS = '1000';
      process.env.MCP_LISTEN_MAX_SECONDS = '10';
      const res = fakeRes();
      serveSubscriptionListen({ res, id: 7, params: {}, serverInfo: { name: 'gw', version: '1' }, toolsGatewayId: null });
      jest.advanceTimersByTime(3000);
      expect(res.writes.filter((w: string) => w.startsWith(':')).length).toBe(3);
      jest.advanceTimersByTime(7000);
      const last = messages(res).pop();
      expect(last).toEqual({
        jsonrpc: '2.0',
        id: 7,
        result: {
          resultType: 'complete',
          _meta: { 'io.modelcontextprotocol/subscriptionId': 7, 'io.modelcontextprotocol/serverInfo': { name: 'gw', version: '1' } },
        },
      });
      expect(res.ended).toBe(true);
    });

    it('honours toolsListChanged only where tools can change', () => {
      expect(acknowledgedFilter({ toolsListChanged: true }, false)).toEqual({});
      expect(acknowledgedFilter({ toolsListChanged: true, resourcesListChanged: true }, true)).toEqual({ toolsListChanged: true });
    });
  });
});
