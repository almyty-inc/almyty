import { McpClientService, MCP_PROTOCOL_VERSION } from '../mcp-client.service';
import { snapshotEnv } from '../../../test/env';

/**
 * The client against modern (2026-07-28), legacy and dual-era servers:
 * which era it picks, what each request carries, and what it does with a
 * task, a request for input, or a server that changed its era. All network
 * is a scripted fake: no socket is opened.
 */
type Sent = { method: string; params: any; headers: Record<string, string>; id?: number };
type Handler = (msg: Sent) => Response | Promise<Response>;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const ok = (id: number | undefined, result: unknown) => json({ jsonrpc: '2.0', id, result });
const err = (id: number | undefined, code: number, message: string, data?: unknown, status = 200) =>
  json({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } }, status);

const MODERN = '2026-07-28';
const URL_ = 'https://mcp.example.com/mcp';

function serverWith(handler: Handler) {
  const sent: Sent[] = [];
  const fetchMock = jest.fn(async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const msg: Sent = { method: body.method, params: body.params, headers: init.headers, id: body.id };
    sent.push(msg);
    return handler(msg);
  });
  (global as any).fetch = fetchMock;
  return { sent, fetchMock };
}

/** A 2026-07-28 server: discover, tools, a tool per behaviour below. */
function modernServer(tools: (msg: Sent) => Response | null = () => null): Handler {
  return (msg) => {
    if (msg.method === 'server/discover') {
      return ok(msg.id, {
        resultType: 'complete',
        supportedVersions: [MODERN, '2025-11-25'],
        capabilities: { tools: {} },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'modern-fixture', version: '2.0.0' } },
      });
    }
    return tools(msg) ?? err(msg.id, -32601, `Method not found: ${msg.method}`, undefined, 404);
  };
}

/** A legacy (stateful SDK 1.x style) server: anything but initialize without a session is a 400. */
function legacyServer(onCall: (msg: Sent) => Response | null = () => null): Handler {
  return (msg) => {
    if (msg.method === 'initialize') {
      return json({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'legacy-fixture', version: '1.0.0' } } }, 200, { 'mcp-session-id': 'sess-1' });
    }
    if (msg.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (!msg.headers['Mcp-Session-Id']) return err(null as any, -32000, 'Bad Request: No valid session ID provided', undefined, 400);
    return onCall(msg) ?? err(msg.id, -32601, 'Method not found');
  };
}

describe('McpClientService eras', () => {
  const restore = snapshotEnv(
    'MCP_CLIENT_ERA',
    'MCP_CLIENT_TASK_POLL_MIN_MS',
    'MCP_CLIENT_TASK_POLL_MAX_MS',
    'MCP_CLIENT_TASK_DEADLINE_MS',
    'MCP_CLIENT_INPUT_ROUNDS',
    'MCP_ALLOW_PRIVATE_URLS',
  );
  const realFetch = global.fetch;
  let client: McpClientService;
  beforeEach(() => {
    client = new McpClientService();
    process.env.MCP_CLIENT_TASK_POLL_MIN_MS = '50';
    process.env.MCP_CLIENT_TASK_POLL_MAX_MS = '50';
  });
  afterEach(() => {
    (global as any).fetch = realFetch;
    restore();
  });

  describe('finding the era', () => {
    it('speaks 2026-07-28 to a server that answers server/discover, without initialize', async () => {
      const { sent } = serverWith(modernServer());
      const info = await client.connect({ url: URL_ });
      expect(info).toMatchObject({ era: 'modern', protocolVersion: MODERN, serverInfo: { name: 'modern-fixture' }, sessionId: null });
      expect(sent.map((s) => s.method)).toEqual(['server/discover']);
      const probe = sent[0];
      expect(probe.params._meta).toEqual({
        'io.modelcontextprotocol/protocolVersion': MODERN,
        'io.modelcontextprotocol/clientCapabilities': { roots: {}, extensions: { 'io.modelcontextprotocol/tasks': {} } },
        'io.modelcontextprotocol/clientInfo': { name: 'almyty-mcp-client', version: '1.0.0' },
      });
      expect(probe.headers).toMatchObject({ 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'server/discover' });
      expect(probe.headers['Mcp-Session-Id']).toBeUndefined();
    });

    it.each([
      ['a 400 "no session" from a stateful legacy server', legacyServer()],
      ['a 200 method-not-found from a stateless legacy server', (m: Sent) => (m.method === 'server/discover' ? err(m.id, -32601, 'Method not found') : legacyServer()(m))],
      ['a bare 404', (m: Sent) => (m.method === 'server/discover' ? new Response('Not Found', { status: 404 }) : legacyServer()(m))],
      ['a 405', (m: Sent) => (m.method === 'server/discover' ? new Response(null, { status: 405 }) : legacyServer()(m))],
      ['a discover result without supportedVersions', (m: Sent) => (m.method === 'server/discover' ? ok(m.id, { hello: 1 }) : legacyServer()(m))],
    ])('falls back to initialize on %s', async (_label, handler) => {
      const { sent } = serverWith(handler as Handler);
      const info = await client.connect({ url: URL_ });
      expect(info).toMatchObject({ era: 'legacy', protocolVersion: '2025-06-18', sessionId: 'sess-1' });
      expect(sent.map((s) => s.method)).toEqual(['server/discover', 'initialize', 'notifications/initialized']);
      expect(sent[1].params.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    });

    it('falls back when a dual-era server does not speak our modern version (-32022 listing legacy versions)', async () => {
      const { sent } = serverWith((m) =>
        m.method === 'server/discover'
          ? err(m.id, -32022, 'Unsupported protocol version', { supported: ['2025-11-25'], requested: MODERN }, 400)
          : legacyServer()(m),
      );
      expect((await client.connect({ url: URL_ })).era).toBe('legacy');
      expect(sent.map((s) => s.method)).toContain('initialize');
    });

    it('stops with MCP_UNSUPPORTED_VERSION when a modern-only server speaks no version we know', async () => {
      const { sent } = serverWith((m) => err(m.id, -32022, 'Unsupported protocol version', { supported: ['2027-01-01'], requested: MODERN }, 400));
      await expect(client.connect({ url: URL_ })).rejects.toMatchObject({ code: 'MCP_UNSUPPORTED_VERSION', data: { supported: ['2027-01-01'] } });
      expect(sent.map((s) => s.method)).toEqual(['server/discover']);
    });

    it('does not fall back on a modern error about the request itself', async () => {
      serverWith((m) => err(m.id, -32020, 'Header mismatch', undefined, 400));
      await expect(client.connect({ url: URL_ })).rejects.toMatchObject({ code: 'MCP_PROTOCOL_ERROR' });
    });

    it('does not fall back when the server cannot be reached', async () => {
      (global as any).fetch = jest.fn().mockRejectedValue(new TypeError('fetch failed'));
      await expect(client.connect({ url: URL_ })).rejects.toMatchObject({ code: 'MCP_CONNECT_FAILED' });
    });

    it('uses the cached era without probing, and MCP_CLIENT_ERA pins one', async () => {
      const modern = serverWith(modernServer());
      expect(await client.connect({ url: URL_, era: 'modern', protocolVersion: MODERN })).toMatchObject({ era: 'modern' });
      expect(modern.sent).toHaveLength(0);

      const legacy = serverWith(legacyServer());
      await client.connect({ url: URL_, era: 'legacy' });
      expect(legacy.sent[0].method).toBe('initialize');

      process.env.MCP_CLIENT_ERA = 'legacy';
      const pinned = serverWith(legacyServer());
      await client.connect({ url: URL_ });
      expect(pinned.sent[0].method).toBe('initialize');

      process.env.MCP_CLIENT_ERA = 'modern';
      serverWith(legacyServer());
      await expect(client.connect({ url: URL_ })).rejects.toMatchObject({ code: 'MCP_PROTOCOL_ERROR' });
    });
  });

  describe('a modern server', () => {
    const listing = {
      tools: [
        {
          name: 'execute_sql',
          title: 'Execute SQL',
          description: 'Run a query',
          inputSchema: { type: 'object', properties: { region: { type: 'string', 'x-mcp-header': 'Region' }, query: { type: 'string' } } },
          outputSchema: { type: 'object', properties: { rows: { type: 'array' } } },
          annotations: { readOnlyHint: true, openWorldHint: true },
          icons: [{ src: 'https://cdn.example.com/sql.svg', mimeType: 'image/svg+xml' }],
        },
        { name: 'bad_header', inputSchema: { type: 'object', properties: { list: { type: 'array', items: { type: 'object', properties: { r: { type: 'string', 'x-mcp-header': 'R' } } } } } } },
        { name: 'number_header', inputSchema: { type: 'object', properties: { n: { type: 'number', 'x-mcp-header': 'N' } } } },
      ],
    };

    it('lists tools with their metadata and leaves out tools with invalid x-mcp-header annotations', async () => {
      const { sent } = serverWith(modernServer((m) => (m.method === 'tools/list' ? ok(m.id, listing) : null)));
      const { tools, init, rejected } = await client.listTools({ url: URL_ });
      expect(init.era).toBe('modern');
      expect(tools).toEqual([
        {
          name: 'execute_sql',
          title: 'Execute SQL',
          description: 'Run a query',
          inputSchema: listing.tools[0].inputSchema,
          outputSchema: listing.tools[0].outputSchema,
          annotations: { readOnlyHint: true, openWorldHint: true },
          icons: [{ src: 'https://cdn.example.com/sql.svg', mimeType: 'image/svg+xml' }],
        },
      ]);
      expect(rejected).toEqual([
        { name: 'bad_header', reason: expect.stringContaining('not on a statically reachable property') },
        { name: 'number_header', reason: expect.stringContaining('number parameter') },
      ]);
      expect(sent[1].headers).toMatchObject({ 'Mcp-Method': 'tools/list', 'MCP-Protocol-Version': MODERN });
      expect(sent[1].headers['Mcp-Name']).toBeUndefined();
    });

    it('calls a tool with _meta, Mcp-Name, Mcp-Param headers and no session', async () => {
      const { sent } = serverWith(modernServer((m) =>
        m.method === 'tools/call' ? ok(m.id, { resultType: 'complete', content: [{ type: 'text', text: '[]' }], structuredContent: [] }) : null,
      ));
      const result = await client.callTool(
        { url: URL_, era: 'modern', protocolVersion: MODERN },
        'execute_sql',
        { region: 'eu-west 1 ', query: 'select 1' },
        { tool: { inputSchema: listing.tools[0].inputSchema } },
      );
      expect(result).toEqual({ content: [{ type: 'text', text: '[]' }], structuredContent: [], isError: false });
      expect(sent).toHaveLength(1);
      expect(sent[0].headers).toMatchObject({
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'execute_sql',
        // Trailing whitespace: base64 sentinel.
        'Mcp-Param-Region': `=?base64?${Buffer.from('eu-west 1 ').toString('base64')}?=`,
      });
      expect(sent[0].params).toMatchObject({ name: 'execute_sql', arguments: { region: 'eu-west 1 ', query: 'select 1' } });
      expect(sent[0].params._meta['io.modelcontextprotocol/clientCapabilities']).toEqual({ roots: {}, extensions: { 'io.modelcontextprotocol/tasks': {} } });
    });

    it('encodes a non-ASCII tool name in Mcp-Name and declares elicitation only when someone can be asked', async () => {
      const { sent } = serverWith(modernServer((m) => (m.method === 'tools/call' ? ok(m.id, { content: [] }) : null)));
      await client.callToolOutcome({ url: URL_, era: 'modern', protocolVersion: MODERN }, 'grüße', {}, { canElicit: true });
      expect(sent[0].headers['Mcp-Name']).toBe(`=?base64?${Buffer.from('grüße').toString('base64')}?=`);
      expect(sent[0].params._meta['io.modelcontextprotocol/clientCapabilities'].elicitation).toEqual({ form: {} });
    });

    it('probes again when a server cached as modern now answers like a legacy one', async () => {
      const { sent } = serverWith(legacyServer((m) => (m.method === 'tools/call' ? ok(m.id, { content: [{ type: 'text', text: 'ok' }] }) : null)));
      const { outcome, init } = await client.callToolOutcome({ url: URL_, era: 'modern', protocolVersion: MODERN }, 't', {});
      expect(init.era).toBe('legacy');
      expect(outcome).toEqual({ kind: 'result', result: { content: [{ type: 'text', text: 'ok' }], isError: false } });
      expect(sent.map((s) => s.method)).toEqual(['tools/call', 'server/discover', 'initialize', 'notifications/initialized', 'tools/call']);
    });
  });

  describe('tasks', () => {
    const taskHandle = (id: number | undefined) => ok(id, { resultType: 'task', taskId: 'task-1', status: 'working', ttlMs: 60_000, pollIntervalMs: 1, createdAt: 'x', lastUpdatedAt: 'x' });

    it('follows a task with tasks/get until it completes', async () => {
      let polls = 0;
      const { sent } = serverWith(modernServer((m) => {
        if (m.method === 'tools/call') return taskHandle(m.id);
        if (m.method === 'tasks/get') {
          polls++;
          return ok(m.id, polls < 2
            ? { resultType: 'complete', taskId: 'task-1', status: 'working' }
            : { resultType: 'complete', taskId: 'task-1', status: 'completed', result: { content: [{ type: 'text', text: 'report' }], isError: false } });
        }
        return null;
      }));
      const result = await client.callTool({ url: URL_, era: 'modern', protocolVersion: MODERN }, 'report', {});
      expect(result.content).toEqual([{ type: 'text', text: 'report' }]);
      const gets = sent.filter((s) => s.method === 'tasks/get');
      expect(gets).toHaveLength(2);
      expect(gets[0].headers['Mcp-Name']).toBe('task-1');
      expect(gets[0].params).toMatchObject({ taskId: 'task-1' });
    });

    it('reports a failed task as a remote error', async () => {
      serverWith(modernServer((m) =>
        m.method === 'tools/call' ? taskHandle(m.id)
          : m.method === 'tasks/get' ? ok(m.id, { taskId: 'task-1', status: 'failed', error: { code: -32603, message: 'rate limited' } }) : null,
      ));
      await expect(client.callTool({ url: URL_, era: 'modern', protocolVersion: MODERN }, 'r', {})).rejects.toMatchObject({
        code: 'MCP_REMOTE_ERROR',
        message: expect.stringContaining('rate limited'),
      });
    });

    it('cancels a task that outlives MCP_CLIENT_TASK_DEADLINE_MS, and one whose caller gave up', async () => {
      process.env.MCP_CLIENT_TASK_DEADLINE_MS = '1000';
      process.env.MCP_CLIENT_TASK_POLL_MIN_MS = '600';
      process.env.MCP_CLIENT_TASK_POLL_MAX_MS = '600';
      const working = (m: Sent) =>
        m.method === 'tools/call' ? taskHandle(m.id)
          : m.method === 'tasks/get' ? ok(m.id, { taskId: 'task-1', status: 'working' })
            : m.method === 'tasks/cancel' ? ok(m.id, { resultType: 'complete' }) : null;
      const late = serverWith(modernServer(working));
      await expect(client.callTool({ url: URL_, era: 'modern', protocolVersion: MODERN }, 'r', {})).rejects.toMatchObject({ code: 'MCP_TIMEOUT' });
      const cancel = late.sent.find((s) => s.method === 'tasks/cancel')!;
      expect(cancel.params.taskId).toBe('task-1');
      expect(cancel.headers['Mcp-Name']).toBe('task-1');

      process.env.MCP_CLIENT_TASK_DEADLINE_MS = '600000';
      const controller = new AbortController();
      const gaveUp = serverWith(modernServer((m) => {
        if (m.method === 'tasks/get') controller.abort();
        return working(m);
      }));
      await expect(client.callTool({ url: URL_, era: 'modern', protocolVersion: MODERN, signal: controller.signal }, 'r', {})).rejects.toMatchObject({ code: 'MCP_TIMEOUT', message: expect.stringContaining('cancelled') });
      expect(gaveUp.sent.some((s) => s.method === 'tasks/cancel')).toBe(true);
    });
  });

  describe('input_required', () => {
    const ask = {
      resultType: 'input_required',
      inputRequests: { region: { method: 'elicitation/create', params: { mode: 'form', message: 'Which region?', requestedSchema: { type: 'object', properties: { region: { type: 'string' } } } } } },
      requestState: 'opaque-1',
    };

    it('answers roots/list with no roots and retries with the echoed requestState', async () => {
      const { sent } = serverWith(modernServer((m) => {
        if (m.method !== 'tools/call') return null;
        if (!m.params.requestState) return ok(m.id, { resultType: 'input_required', inputRequests: { r: { method: 'roots/list' } }, requestState: 'state-roots' });
        return ok(m.id, { content: [{ type: 'text', text: 'done' }] });
      }));
      const result = await client.callTool({ url: URL_, era: 'modern', protocolVersion: MODERN }, 't', { a: 1 });
      expect(result.content).toEqual([{ type: 'text', text: 'done' }]);
      expect(sent[1].params).toMatchObject({ inputResponses: { r: { roots: [] } }, requestState: 'state-roots', arguments: { a: 1 } });
      expect(sent[1].id).not.toBe(sent[0].id);
    });

    it('refuses sampling with a tool error', async () => {
      serverWith(modernServer((m) => (m.method === 'tools/call' ? ok(m.id, { resultType: 'input_required', inputRequests: { s: { method: 'sampling/createMessage', params: {} } } }) : null)));
      const result = await client.callTool({ url: URL_, era: 'modern', protocolVersion: MODERN }, 't', {});
      expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('sampling') }] });
    });

    it('hands an elicitation to a caller that can ask, and is a tool error for one that cannot', async () => {
      serverWith(modernServer((m) => (m.method === 'tools/call' ? ok(m.id, ask) : null)));
      const { outcome } = await client.callToolOutcome({ url: URL_, era: 'modern', protocolVersion: MODERN }, 't', {}, { canElicit: true });
      expect(outcome).toEqual({ kind: 'input_required', inputRequests: ask.inputRequests, requestState: 'opaque-1' });

      const result = await client.callTool({ url: URL_, era: 'modern', protocolVersion: MODERN }, 't', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Which region?');
    });

    it('turns a MissingRequiredClientCapability for elicitation into a tool error, not a broken connection', async () => {
      serverWith(modernServer((m) =>
        m.method === 'tools/call'
          ? err(m.id, -32021, 'Missing required client capability', { requiredCapabilities: { elicitation: { form: {} } } }, 400)
          : null,
      ));
      const result = await client.callTool({ url: URL_, era: 'modern', protocolVersion: MODERN }, 'reserve', {});
      expect(result).toEqual({ content: [{ type: 'text', text: expect.stringContaining('needs to ask a person') }], isError: true });
    });

    it('sends the answer on the retry', async () => {
      const { sent } = serverWith(modernServer((m) => (m.method === 'tools/call' ? ok(m.id, { content: [{ type: 'text', text: 'eu' }] }) : null)));
      await client.callToolOutcome({ url: URL_, era: 'modern', protocolVersion: MODERN }, 't', {}, {
        canElicit: true,
        inputResponses: { region: { action: 'accept', content: { region: 'eu' } } },
        requestState: 'opaque-1',
      });
      expect(sent[0].params).toMatchObject({ inputResponses: { region: { action: 'accept', content: { region: 'eu' } } }, requestState: 'opaque-1' });
    });

    it('returns a task waiting for input with its id, and answers it with tasks/update', async () => {
      let answered = false;
      const { sent } = serverWith(modernServer((m) => {
        if (m.method === 'tools/call') return ok(m.id, { resultType: 'task', taskId: 'task-9', status: 'working', pollIntervalMs: 1 });
        if (m.method === 'tasks/update') {
          answered = true;
          return ok(m.id, { resultType: 'complete' });
        }
        if (m.method === 'tasks/get') {
          return ok(m.id, answered
            ? { taskId: 'task-9', status: 'completed', result: { content: [{ type: 'text', text: 'thanks' }] } }
            : { taskId: 'task-9', status: 'input_required', inputRequests: ask.inputRequests });
        }
        return null;
      }));
      const first = await client.callToolOutcome({ url: URL_, era: 'modern', protocolVersion: MODERN }, 't', {}, { canElicit: true });
      expect(first.outcome).toEqual({ kind: 'input_required', inputRequests: ask.inputRequests, taskId: 'task-9' });

      const second = await client.callToolOutcome({ url: URL_, era: 'modern', protocolVersion: MODERN }, 't', {}, {
        canElicit: true,
        taskId: 'task-9',
        inputResponses: { region: { action: 'accept', content: { region: 'eu' } } },
      });
      expect(second.outcome).toEqual({ kind: 'result', result: { content: [{ type: 'text', text: 'thanks' }], isError: false } });
      const update = sent.find((s) => s.method === 'tasks/update')!;
      expect(update.params).toMatchObject({ taskId: 'task-9', inputResponses: { region: { action: 'accept', content: { region: 'eu' } } } });
      expect(update.headers['Mcp-Name']).toBe('task-9');
    });
  });
});
