import { McpClientService, McpClientError, MCP_PROTOCOL_VERSION } from '../mcp-client.service';

/**
 * All network is mocked: global.fetch is replaced with a jest mock
 * that serves canned JSON-RPC / SSE fixtures. No socket is ever opened.
 */

const jsonRes = (body: any, headers: Record<string, string> = {}, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const sseRes = (messages: any[], headers: Record<string, string> = {}) =>
  new Response(
    messages.map((m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`).join(''),
    { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } },
  );

const accepted = () => new Response(null, { status: 202 });

const rpcResult = (id: number, result: any) => ({ jsonrpc: '2.0', id, result });

const initResult = (id: number, sessionHeaders: Record<string, string> = {}) =>
  jsonRes(
    rpcResult(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'fixture-server', version: '9.9.9' },
    }),
    sessionHeaders,
  );

describe('McpClientService', () => {
  let service: McpClientService;
  let fetchMock: jest.Mock;
  const realFetch = global.fetch;

  beforeEach(() => {
    service = new McpClientService();
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
    delete process.env.MCP_ALLOW_PRIVATE_URLS;
  });

  afterEach(() => {
    (global as any).fetch = realFetch;
    delete process.env.MCP_ALLOW_PRIVATE_URLS;
  });

  /** id of the nth JSON-RPC request fetch saw (skipping notifications). */
  const sentBody = (call: number) => JSON.parse(fetchMock.mock.calls[call][1].body);

  describe('initialize', () => {
    it('performs the handshake, sends notifications/initialized, and captures Mcp-Session-Id', async () => {
      fetchMock
        .mockImplementationOnce(async (_url, init: any) => {
          const body = JSON.parse(init.body);
          return initResult(body.id, { 'mcp-session-id': 'session-abc' });
        })
        .mockResolvedValueOnce(accepted());

      const info = await service.initialize({ url: 'https://mcp.example.com/mcp' });

      expect(info.sessionId).toBe('session-abc');
      expect(info.serverInfo).toEqual({ name: 'fixture-server', version: '9.9.9' });

      // First request is initialize with our protocol version.
      const initBody = sentBody(0);
      expect(initBody.method).toBe('initialize');
      expect(initBody.params.protocolVersion).toBe(MCP_PROTOCOL_VERSION);

      // Second request is the initialized notification carrying the session id.
      const notifyBody = sentBody(1);
      expect(notifyBody.method).toBe('notifications/initialized');
      const notifyHeaders = fetchMock.mock.calls[1][1].headers;
      expect(notifyHeaders['Mcp-Session-Id']).toBe('session-abc');
    });

    it('attaches configured auth headers to every request', async () => {
      fetchMock
        .mockImplementationOnce(async (_url, init: any) => initResult(JSON.parse(init.body).id))
        .mockResolvedValueOnce(accepted());

      await service.initialize({
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: 'Bearer secret-token', 'X-Api-Key': 'k-123' },
      });

      for (const call of fetchMock.mock.calls) {
        expect(call[1].headers['Authorization']).toBe('Bearer secret-token');
        expect(call[1].headers['X-Api-Key']).toBe('k-123');
      }
    });
  });

  describe('listTools', () => {
    it('initializes then pages through tools/list cursors', async () => {
      fetchMock
        .mockImplementationOnce(async (_url, init: any) => initResult(JSON.parse(init.body).id))
        .mockResolvedValueOnce(accepted())
        .mockImplementationOnce(async (_url, init: any) =>
          jsonRes(rpcResult(JSON.parse(init.body).id, {
            tools: [{ name: 'get_weather', description: 'w', inputSchema: { type: 'object' } }],
            nextCursor: 'page-2',
          })),
        )
        .mockImplementationOnce(async (_url, init: any) =>
          jsonRes(rpcResult(JSON.parse(init.body).id, {
            tools: [{ name: 'get_alerts', inputSchema: { type: 'object' } }],
          })),
        );

      const { tools, init } = await service.listTools({ url: 'https://mcp.example.com/mcp' });

      expect(tools.map((t) => t.name)).toEqual(['get_weather', 'get_alerts']);
      expect(init.serverInfo.name).toBe('fixture-server');
      // Second tools/list call carried the cursor.
      expect(sentBody(3).params).toEqual({ cursor: 'page-2' });
    });

    it('raises MCP_PROTOCOL_ERROR when tools/list has no tools array', async () => {
      fetchMock
        .mockImplementationOnce(async (_url, init: any) => initResult(JSON.parse(init.body).id))
        .mockResolvedValueOnce(accepted())
        .mockImplementationOnce(async (_url, init: any) =>
          jsonRes(rpcResult(JSON.parse(init.body).id, { nope: true })),
        );

      await expect(service.listTools({ url: 'https://mcp.example.com/mcp' })).rejects.toMatchObject({
        name: 'McpClientError',
        code: 'MCP_PROTOCOL_ERROR',
      });
    });
  });

  describe('callTool', () => {
    it('sends tools/call and parses a plain JSON response', async () => {
      fetchMock
        .mockImplementationOnce(async (_url, init: any) =>
          initResult(JSON.parse(init.body).id, { 'mcp-session-id': 's-1' }))
        .mockResolvedValueOnce(accepted())
        .mockImplementationOnce(async (_url, init: any) =>
          jsonRes(rpcResult(JSON.parse(init.body).id, {
            content: [{ type: 'text', text: '{"temp":21}' }],
          })),
        );

      const result = await service.callTool(
        { url: 'https://mcp.example.com/mcp' },
        'get_weather',
        { city: 'Berlin' },
      );

      expect(result.isError).toBe(false);
      expect(result.content).toEqual([{ type: 'text', text: '{"temp":21}' }]);

      const callBody = sentBody(2);
      expect(callBody.method).toBe('tools/call');
      expect(callBody.params).toEqual({ name: 'get_weather', arguments: { city: 'Berlin' } });
      // Session id from initialize is echoed on the call.
      expect(fetchMock.mock.calls[2][1].headers['Mcp-Session-Id']).toBe('s-1');
      expect(fetchMock.mock.calls[2][1].headers['MCP-Protocol-Version']).toBe(MCP_PROTOCOL_VERSION);
    });

    it('parses SSE-framed responses and ignores unrelated events', async () => {
      fetchMock
        .mockImplementationOnce(async (_url, init: any) => initResult(JSON.parse(init.body).id))
        .mockResolvedValueOnce(accepted())
        .mockImplementationOnce(async (_url, init: any) => {
          const id = JSON.parse(init.body).id;
          return sseRes([
            { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info' } },
            rpcResult(id, { content: [{ type: 'text', text: 'sunny' }] }),
          ]);
        });

      const result = await service.callTool({ url: 'https://mcp.example.com/mcp' }, 't', {});
      expect(result.content).toEqual([{ type: 'text', text: 'sunny' }]);
    });

    it('maps a JSON-RPC error response to MCP_REMOTE_ERROR', async () => {
      fetchMock
        .mockImplementationOnce(async (_url, init: any) => initResult(JSON.parse(init.body).id))
        .mockResolvedValueOnce(accepted())
        .mockImplementationOnce(async (_url, init: any) =>
          jsonRes({
            jsonrpc: '2.0',
            id: JSON.parse(init.body).id,
            error: { code: -32602, message: 'Unknown tool: nope' },
          }),
        );

      await expect(
        service.callTool({ url: 'https://mcp.example.com/mcp' }, 'nope', {}),
      ).rejects.toMatchObject({ code: 'MCP_REMOTE_ERROR', message: expect.stringContaining('Unknown tool') });
    });

    it('maps HTTP-level failures to MCP_HTTP_ERROR', async () => {
      fetchMock.mockResolvedValueOnce(new Response('upstream down', { status: 502 }));

      await expect(
        service.callTool({ url: 'https://mcp.example.com/mcp' }, 't', {}),
      ).rejects.toMatchObject({ code: 'MCP_HTTP_ERROR', data: expect.objectContaining({ status: 502 }) });
    });

    it('maps network failures to MCP_CONNECT_FAILED', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

      await expect(
        service.callTool({ url: 'https://mcp.example.com/mcp' }, 't', {}),
      ).rejects.toMatchObject({ code: 'MCP_CONNECT_FAILED' });
    });

    it('aborts slow requests with MCP_TIMEOUT', async () => {
      fetchMock.mockImplementationOnce(
        (_url: string, init: any) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      );

      await expect(
        service.callTool({ url: 'https://mcp.example.com/mcp', timeoutMs: 20 }, 't', {}),
      ).rejects.toMatchObject({ code: 'MCP_TIMEOUT' });
    });
  });

  describe('SSRF protection', () => {
    it.each([
      'http://127.0.0.1:8080/mcp',
      'http://10.0.0.5/mcp',
      'http://192.168.1.10/mcp',
      'http://169.254.169.254/latest/meta-data',
      'http://localhost:3000/mcp',
      'ftp://mcp.example.com/mcp',
    ])('blocks %s without touching the network', async (url) => {
      await expect(service.callTool({ url }, 't', {})).rejects.toMatchObject({
        code: 'MCP_URL_BLOCKED',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('allows private ranges when MCP_ALLOW_PRIVATE_URLS=true', async () => {
      process.env.MCP_ALLOW_PRIVATE_URLS = 'true';
      fetchMock
        .mockImplementationOnce(async (_url, init: any) => initResult(JSON.parse(init.body).id))
        .mockResolvedValueOnce(accepted())
        .mockImplementationOnce(async (_url, init: any) =>
          jsonRes(rpcResult(JSON.parse(init.body).id, { content: [] })),
        );

      const result = await service.callTool({ url: 'http://10.0.0.5:8080/mcp' }, 't', {});
      expect(result.content).toEqual([]);
      expect(fetchMock).toHaveBeenCalled();
    });

    it('still rejects non-http protocols even with the private-URL override', async () => {
      process.env.MCP_ALLOW_PRIVATE_URLS = 'true';
      await expect(service.callTool({ url: 'file:///etc/passwd' }, 't', {})).rejects.toMatchObject({
        code: 'MCP_URL_BLOCKED',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
