/**
 * Both protocol eras over stdio, through the real entry point (MCP SDK 2.x
 * `serveStdio`, docs/design/mcp-2026-07-28.md decision 12):
 *
 *  - a client that opens with `initialize` (Claude Desktop, Cursor and most
 *    editors today) is served the earlier protocol, as before;
 *  - a client that opens with a 2026-07-28 request is served 2026-07-28,
 *    and gets no notification outside a `subscriptions/listen` stream;
 *  - in full mode a gateway tool keeps its title, output schema and
 *    annotations, and its structured result reaches the client;
 *  - upstream, the proxy asks almyty in 2026-07-28.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MODERN_META, closedPort, fakeAlmyty, pause, startServer, waitFor, type FakeAlmyty, type StdioServer } from './stdio-harness';

let server: StdioServer | undefined;
let almyty: FakeAlmyty | undefined;

afterEach(async () => {
  server?.stop();
  server = undefined;
  await almyty?.close();
  almyty = undefined;
});

describe('MCP eras over stdio', () => {
  it('serves a 2026-07-28 client statelessly, with no notification of its own', async () => {
    server = startServer({ ALMYTY_URL: `http://127.0.0.1:${await closedPort()}`, ALMYTY_MODE: 'skill-first' });
    server.send({ id: 1, method: 'server/discover', params: { _meta: MODERN_META } });
    const discover = await server.response(1);
    expect(discover.result.supportedVersions).toContain('2026-07-28');
    expect(discover.result.resultType).toBe('complete');

    // Discovery fails (nothing listens) and the late registrations run.
    await waitFor(() => server!.stderr().includes('gateway discovery failed'), 'discovery to fail');
    server.send({ id: 2, method: 'tools/list', params: { _meta: MODERN_META } });
    const list = await server.response(2);
    expect(list.result.tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(['almyty_execute', 'almyty_search', 'almyty_list_apis']));
    await pause(300);
    expect(server.messages.filter((m) => m.method)).toEqual([]);
  }, 30_000);

  it('still serves a client that opens with initialize, at the version it asked for', async () => {
    server = startServer({ ALMYTY_URL: `http://127.0.0.1:${await closedPort()}`, ALMYTY_MODE: 'skill-first' });
    for (const [id, version] of [[1, '2025-06-18']] as const) {
      server.send({ id, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'claude-ai', version: '0.1.0' } } });
      expect((await server.response(id)).result.protocolVersion).toBe(version);
    }
  }, 30_000);

  it('registers a gateway tool in full mode with what the gateway says about it, and asks almyty in 2026-07-28', async () => {
    almyty = await fakeAlmyty();
    server = startServer({ ALMYTY_URL: almyty.url, ALMYTY_MODE: 'full' });
    server.send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'spec', version: '0' } } });
    await server.response(1);
    server.send({ method: 'notifications/initialized' });

    server.send({ id: 2, method: 'tools/list', params: {} });
    const tool = (await server.response(2)).result.tools.find((t: any) => t.name === 'orders_get_order');
    expect(tool).toMatchObject({
      title: 'Get order',
      description: 'Look an order up by its number',
      inputSchema: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
      outputSchema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' } } },
      annotations: { readOnlyHint: true, openWorldHint: true },
    });

    server.send({ id: 3, method: 'tools/call', params: { name: 'orders_get_order', arguments: { orderId: 'NW-10428' } } });
    const call = await server.response(3);
    expect(call.result.structuredContent).toEqual({ id: 'NW-10428', status: 'delayed' });
    expect(call.result.isError).toBeFalsy();

    const upstreamCall = almyty.requests.find((r) => r.body.method === 'tools/call')!;
    expect(upstreamCall.headers['mcp-protocol-version']).toBe('2026-07-28');
    expect(upstreamCall.headers['mcp-name']).toBe('orders_get_order');
    expect(upstreamCall.body.params._meta['io.modelcontextprotocol/clientInfo'].name).toBe('@almyty/mcp-server');
  }, 30_000);

  it('tells a 2026-07-28 client about the late gateway tools on its listen stream only', async () => {
    // tools/list answers late, so the gateway tools are registered after the stream is open.
    almyty = await fakeAlmyty({ toolsListDelayMs: 1_500 });
    server = startServer({ ALMYTY_URL: almyty.url, ALMYTY_MODE: 'full', ALMYTY_DISCOVERY_WAIT_MS: '0' });
    server.send({ id: 1, method: 'server/discover', params: { _meta: MODERN_META } });
    await server.response(1);
    server.send({ id: 9, method: 'subscriptions/listen', params: { _meta: MODERN_META, notifications: { toolsListChanged: true } } });
    await waitFor(() => server!.messages.some((m) => m.method === 'notifications/subscriptions/acknowledged'), 'the listen acknowledgement');
    await waitFor(() => server!.messages.some((m) => m.method === 'notifications/tools/list_changed'), 'tools/list_changed on the stream');
    const notes = server.messages.filter((m) => m.method && m.method !== 'notifications/subscriptions/acknowledged');
    for (const note of notes) {
      expect(note.params?._meta?.['io.modelcontextprotocol/subscriptionId']).toBe(9);
    }
    server.send({ id: 2, method: 'tools/list', params: { _meta: MODERN_META } });
    expect((await server.response(2)).result.tools.map((t: any) => t.name)).toContain('orders_get_order');
  }, 30_000);
});
