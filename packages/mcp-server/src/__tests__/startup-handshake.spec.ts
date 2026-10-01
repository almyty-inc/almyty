/**
 * The MCP lifecycle: until the client has sent `notifications/initialized`,
 * the server may answer requests but must not send notifications of its
 * own (#875). What discovery found is registered late when discovery is
 * slower than the client, and every late registration makes the SDK send a
 * list_changed notification; those are held until the client is ready.
 *
 * And the other side of it: discovery that has finished by the client's
 * first message (waited for up to ALMYTY_DISCOVERY_WAIT_MS) is registered
 * before the handshake, so the first tools/list is complete and nothing has
 * to be announced. Claude Code's `-p` mode lists tools once and never
 * re-reads them.
 *
 * These drive the real entry point over stdio against a local stand-in for
 * the almyty backend.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { closedPort, fakeAlmyty, pause, startServer, waitFor, type FakeAlmyty, type StdioServer } from './stdio-harness';

let server: StdioServer | undefined;
let almyty: FakeAlmyty | undefined;

afterEach(async () => {
  server?.stop();
  server = undefined;
  await almyty?.close();
  almyty = undefined;
});

const initialize = (id = 1) => ({
  id,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'spec', version: '0' } },
});

describe('startup handshake', () => {
  it('sends no notification before the client has finished initializing, even when discovery completes first', async () => {
    // Discovery answers after 1.5 s; the handshake does not wait for it.
    almyty = await fakeAlmyty({ toolsListDelayMs: 1_500 });
    server = startServer({ ALMYTY_URL: almyty.url, ALMYTY_MODE: 'full', ALMYTY_DISCOVERY_WAIT_MS: '0' });

    server.send(initialize());
    await server.response(1);
    // Discovery finishes and its registrations run while the client has
    // not yet said it is ready.
    await waitFor(() => server!.stderr().includes('gateway tools'), 'discovery to finish');
    await pause(300);
    expect(server.messages.map((m) => m.method ?? `response:${m.id}`)).toEqual(['response:1']);

    // Once the client says it is ready, the late registrations are announced.
    server.send({ method: 'notifications/initialized' });
    await waitFor(
      () => server!.messages.some((m) => m.method === 'notifications/tools/list_changed'),
      'tools/list_changed after initialized',
    );
    expect(server.messages[0].id).toBe(1);
  }, 30_000);

  it('has the gateway tools in the first tools/list when discovery finished first, and announces nothing', async () => {
    almyty = await fakeAlmyty();
    server = startServer({ ALMYTY_URL: almyty.url, ALMYTY_MODE: 'full' });
    await waitFor(() => server!.stderr().includes('gateway tools'), 'discovery to finish');

    server.send(initialize());
    await server.response(1);
    server.send({ method: 'notifications/initialized' });
    server.send({ id: 2, method: 'tools/list', params: {} });
    expect((await server.response(2)).result.tools.map((t: any) => t.name)).toContain('orders_get_order');
    await pause(300);
    expect(server.messages.filter((m) => m.method)).toEqual([]);
  }, 30_000);

  it('waits a little for discovery still under way at the first message', async () => {
    almyty = await fakeAlmyty({ toolsListDelayMs: 800 });
    server = startServer({ ALMYTY_URL: almyty.url, ALMYTY_MODE: 'full', ALMYTY_DISCOVERY_WAIT_MS: '5000' });
    server.send(initialize());
    await server.response(1);
    server.send({ method: 'notifications/initialized' });
    server.send({ id: 2, method: 'tools/list', params: {} });
    expect((await server.response(2)).result.tools.map((t: any) => t.name)).toContain('orders_get_order');
  }, 30_000);

  it('does not hold the handshake for a backend that is down', async () => {
    server = startServer({ ALMYTY_URL: `http://127.0.0.1:${await closedPort()}`, ALMYTY_MODE: 'skill-first' });
    const started = Date.now();
    server.send(initialize());
    await server.response(1);
    expect(Date.now() - started).toBeLessThan(4_000);
  }, 30_000);
});
