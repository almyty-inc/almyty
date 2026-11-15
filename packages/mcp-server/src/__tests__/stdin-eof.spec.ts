/**
 * A client that writes its requests and closes stdin gets every answer.
 *
 * The staging gate pipes its JSON-RPC into the server and closes the pipe
 * (spawnSync with `input`). Discovery takes a moment against a real
 * organization, the first message waits for it inside the serveStdio
 * factory, and the SDK's stdio transport closed on EOF meanwhile: the
 * process exited 0 having written nothing. These drive the real entry
 * point the same way, with discovery held up by the stand-in backend.
 */
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeAlmyty, type FakeAlmyty, type StdioServer, startServer } from './stdio-harness';
import { DrainingStdioTransport } from '../stdio-transport';

let server: StdioServer | undefined;
let almyty: FakeAlmyty | undefined;

afterEach(async () => {
  server?.stop();
  server = undefined;
  await almyty?.close();
  almyty = undefined;
});

const initialize = {
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'spec', version: '0' } },
};

describe('stdin closed while discovery is still running', () => {
  it('answers every request already sent, then exits 0', async () => {
    almyty = await fakeAlmyty({ toolsListDelayMs: 1_500 });
    server = startServer({ ALMYTY_URL: almyty.url, ALMYTY_MODE: 'skill-first', ALMYTY_DISCOVERY_WAIT_MS: '5000' });

    server.send(initialize);
    server.send({ id: 2, method: 'tools/list', params: {} });
    server.send({ id: 3, method: 'no/such/method', params: {} });
    server.send({ id: 4, method: 'tools/call', params: { name: 'almyty_execute', arguments: { wrong: 1 } } });
    server.endInput();

    expect(await server.exited).toBe(0);
    const byId = new Map(server.messages.filter((m) => m.id !== undefined).map((m) => [m.id, m]));
    expect(byId.get(1)?.result?.serverInfo).toBeTruthy();
    expect(byId.get(2)?.result?.tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(['almyty_execute', 'almyty_search']));
    expect(byId.get(3)?.error).toBeTruthy();
    expect(byId.get(4)?.error || byId.get(4)?.result?.isError).toBeTruthy();
  }, 30_000);

  it('exits at once when nothing is owed', async () => {
    almyty = await fakeAlmyty();
    server = startServer({ ALMYTY_URL: almyty.url });
    server.endInput();
    expect(await server.exited).toBe(0);
    expect(server.messages).toEqual([]);
  }, 30_000);
});

describe('DrainingStdioTransport', () => {
  function wire() {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const written: any[] = [];
    stdout.on('data', (chunk) => written.push(...String(chunk).trim().split('\n').map((l) => JSON.parse(l))));
    const transport = new DrainingStdioTransport(stdin, stdout, { drainTimeoutMs: 200 });
    let closed = false;
    transport.onclose = () => { closed = true; };
    const received: any[] = [];
    transport.onmessage = (m) => { received.push(m); };
    return { stdin, transport, written, received, isClosed: () => closed };
  }

  it('stays open after EOF until the last owed answer is written', async () => {
    const t = wire();
    await t.transport.start();
    t.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' })}\n`);
    t.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    t.stdin.end();
    await new Promise((r) => setImmediate(r));
    expect(t.received).toHaveLength(2);
    expect(t.transport.pending).toBe(1);
    expect(t.isClosed()).toBe(false);

    await t.transport.send({ jsonrpc: '2.0', id: 7, result: { tools: [] } } as any);
    expect(t.isClosed()).toBe(true);
    expect(t.written).toEqual([{ jsonrpc: '2.0', id: 7, result: { tools: [] } }]);
  });

  it('gives up on an answer that never comes after drainTimeoutMs', async () => {
    const t = wire();
    const errors: string[] = [];
    t.transport.onerror = (e) => errors.push(e.message);
    await t.transport.start();
    t.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'slow' })}\n`);
    t.stdin.end();
    await new Promise((r) => setTimeout(r, 400));
    expect(t.isClosed()).toBe(true);
    expect(errors.join()).toContain('1 request(s) unanswered');
  });

  it('does not wait for a subscriptions/listen stream', async () => {
    const t = wire();
    await t.transport.start();
    t.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'subscriptions/listen', params: {} })}\n`);
    t.stdin.end();
    await new Promise((r) => setImmediate(r));
    expect(t.isClosed()).toBe(true);
  });
});
