import { describe, it, expect } from 'vitest';

import {
  LEGACY_STREAM_PATH,
  RUNNER_STREAM_PATH,
  StreamableClient,
  envelope,
} from '../src/streamable-client.js';
import { WORKER_PROTOCOL_VERSION } from '../src/protocol.js';

/**
 * The worker stream moved from /mcp/streamable to /runners/stream when the
 * backend split MCP from the runner channel. A runner talks to the new
 * route, and to a backend that predates it through the old one; a 404 that
 * is the backend's own "unknown session" never changes the route.
 * (streamable-client.spec.ts pins reconnect and replay, unchanged.)
 */
function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const unknownSession = {
  v: WORKER_PROTOCOL_VERSION,
  type: 'error',
  id: 'e-1',
  ts: 1,
  payload: { code: -32001, message: 'unknown session' },
};

describe('StreamableClient route', () => {
  it('posts to /runners/stream', async () => {
    const urls: string[] = [];
    const fetchMock = async (url: string) => {
      urls.push(url);
      return new Response(null, { status: 202, headers: { 'mcp-session-id': 'sh_1' } });
    };
    const c = new StreamableClient({ baseUrl: 'http://x', token: 't', fetch: fetchMock as any });
    await c.send(envelope('heartbeat', {}));
    expect(urls).toEqual([`http://x${RUNNER_STREAM_PATH}`]);
  });

  it('falls back to /mcp/streamable on a backend without the route, and stays there', async () => {
    const urls: string[] = [];
    const fetchMock = async (url: string, init: any) => {
      urls.push(`${init.method} ${url}`);
      if (url.endsWith(RUNNER_STREAM_PATH)) {
        return json(404, { statusCode: 404, message: `Cannot ${init.method} ${RUNNER_STREAM_PATH}` });
      }
      return new Response(null, { status: 202, headers: { 'mcp-session-id': 'sh_old' } });
    };
    const c = new StreamableClient({ baseUrl: 'http://x', token: 't', fetch: fetchMock as any });
    const switched: unknown[] = [];
    c.on('route-fallback', (e) => switched.push(e));

    await expect(c.send(envelope('heartbeat', {}))).resolves.toBeNull();
    await c.send(envelope('heartbeat', {}));

    expect(c.getSessionId()).toBe('sh_old');
    expect(switched).toEqual([{ from: RUNNER_STREAM_PATH, to: LEGACY_STREAM_PATH }]);
    expect(urls).toEqual([
      `POST http://x${RUNNER_STREAM_PATH}`,
      `POST http://x${LEGACY_STREAM_PATH}`,
      `POST http://x${LEGACY_STREAM_PATH}`,
    ]);
  });

  it('does not change route on an unknown-session 404', async () => {
    const urls: string[] = [];
    const fetchMock = async (url: string) => {
      urls.push(url);
      return json(404, unknownSession);
    };
    const c = new StreamableClient({ baseUrl: 'http://x', token: 't', fetch: fetchMock as any });
    await expect(c.send(envelope('heartbeat', {}))).rejects.toThrow(/backend POST failed: 404/);
    expect(urls).toEqual([`http://x${RUNNER_STREAM_PATH}`]);
  });

  it('reopens the stream on the legacy route when the GET route is missing, keeping the session', async () => {
    const urls: string[] = [];
    let timer: (() => void) | null = null;
    const fetchMock = async (url: string, init: any) => {
      urls.push(`${init.method} ${url}`);
      if (init.method === 'POST') return new Response(null, { status: 202, headers: { 'mcp-session-id': 'sh_1' } });
      if (url.endsWith(RUNNER_STREAM_PATH)) return json(404, { statusCode: 404, message: `Cannot GET ${RUNNER_STREAM_PATH}` });
      return new Response(new ReadableStream({ start: (c) => c.close() }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    };
    const c = new StreamableClient({
      baseUrl: 'http://x',
      token: 't',
      fetch: fetchMock as any,
      setTimeoutFn: ((fn: () => void) => { timer = fn; return { unref() {} }; }) as any,
    });
    const lost: unknown[] = [];
    c.on('session-lost', (e) => lost.push(e));
    await c.send(envelope('heartbeat', {}));
    // The first send already learned nothing about GET; the GET 404 decides.
    await c.openStream();
    expect(lost).toEqual([]);
    expect(c.getSessionId()).toBe('sh_1');
    timer!();
    await new Promise((r) => setImmediate(r));
    c.stop();
    expect(urls.filter((u) => u.startsWith('GET'))).toEqual([
      `GET http://x${RUNNER_STREAM_PATH}`,
      `GET http://x${LEGACY_STREAM_PATH}`,
    ]);
  });
});

describe('StreamableClient on a fixed route with a renewable token (hosted runners)', () => {
  it('posts to the given route, never falls back, and reads the token on every request', async () => {
    const calls: Array<{ url: string; auth: string }> = [];
    const fetchMock = async (url: string, init: any) => {
      calls.push({ url, auth: init.headers.Authorization });
      if (calls.length === 2) return json(404, { message: `Cannot POST ${RUNNER_STREAM_PATH}` });
      return new Response(null, { status: 202, headers: { 'mcp-session-id': 'sh_h' } });
    };
    let token = 'credential-1';
    const c = new StreamableClient({ baseUrl: 'http://x', token: () => token, streamPath: '/runners/hosted/stream', fetch: fetchMock as any });
    await c.send(envelope('heartbeat', {}));
    token = 'credential-2';
    await expect(c.send(envelope('heartbeat', {}))).rejects.toThrow(/404/);
    expect(calls).toEqual([
      { url: 'http://x/runners/hosted/stream', auth: 'Bearer credential-1' },
      { url: 'http://x/runners/hosted/stream', auth: 'Bearer credential-2' },
    ]);
  });

  it('startStream resolves once the stream is open, while it is still being read', async () => {
    let close!: () => void;
    const body = new ReadableStream<Uint8Array>({ start(ctrl) { close = () => ctrl.close(); } });
    const fetchMock = async (_url: string, init: any) =>
      init.method === 'GET'
        ? new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
        : new Response(null, { status: 202, headers: { 'mcp-session-id': 'sh_s' } });
    const c = new StreamableClient({ baseUrl: 'http://x', token: 't', fetch: fetchMock as any, setTimeoutFn: (() => 0) as any });
    await c.send(envelope('heartbeat', {}));
    await c.startStream();
    c.stop();
    close();
  });
});