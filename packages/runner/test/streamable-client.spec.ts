import { describe, it, expect } from 'vitest';

import { StreamableClient, envelope } from '../src/streamable-client.js';
import { isWorkerEnvelope, WORKER_PROTOCOL_VERSION } from '../src/protocol.js';

/**
 * Streamable client tests against a stubbed fetch. Pins:
 *  - POST returns 202 -> send() resolves null
 *  - POST returns 200 + envelope -> send() resolves the envelope
 *  - GET stream parses SSE frames into envelope events
 *  - On disconnect, reconnect attempts include Last-Event-ID
 *  - Malformed SSE data emits parse-error and continues
 *  - 404 from GET emits session-lost and clears the saved sid
 */

interface FrameOpts {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  json?: unknown;
}

function res(opts: FrameOpts): Response {
  const headers = new Headers(opts.headers);
  if (opts.json !== undefined && !headers.get('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const body = opts.json !== undefined
    ? JSON.stringify(opts.json)
    : opts.body ?? '';
  // Construct a Response. Stream needed for SSE-shaped responses.
  return new Response(body, { status: opts.status ?? 200, headers });
}

function streamRes(headers: Record<string, string>, frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  const h = new Headers(headers);
  h.set('content-type', 'text/event-stream');
  return new Response(stream, { status: 200, headers: h });
}

function frame(id: string, eventName: string, data: unknown): string {
  return `id: ${id}\nevent: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe('StreamableClient', () => {
  it('POST a JSON-RPC body returns the parsed envelope when the backend echoes one inline', async () => {
    const env = envelope('event', { hello: 'world' });
    const fetchMock = async () => res({
      json: { v: WORKER_PROTOCOL_VERSION, type: 'response', id: 'r-1', ts: Date.now(), payload: { ok: true } },
      headers: { 'mcp-session-id': 'sh_1' },
    });
    const c = new StreamableClient({ baseUrl: 'http://x', token: 't', fetch: fetchMock as any });
    const resp = await c.send(env);
    expect(c.getSessionId()).toBe('sh_1');
    expect(resp).not.toBeNull();
    expect(isWorkerEnvelope(resp!)).toBe(true);
  });

  it('POST that returns 202 resolves null (notification semantics)', async () => {
    const fetchMock = async () => res({ status: 202, headers: { 'mcp-session-id': 'sh_a' } });
    const c = new StreamableClient({ baseUrl: 'http://x', token: 't', fetch: fetchMock as any });
    const r = await c.send(envelope('heartbeat', { ts: Date.now() }));
    expect(r).toBeNull();
    expect(c.getSessionId()).toBe('sh_a');
  });

  it('POST with non-2xx surfaces a clear error', async () => {
    const fetchMock = async () => res({ status: 500, body: 'boom' });
    const c = new StreamableClient({ baseUrl: 'http://x', token: 't', fetch: fetchMock as any });
    await expect(c.send(envelope('event', {})))
      .rejects.toThrow(/backend POST failed: 500 boom/);
  });

  it('GET stream parses SSE frames and emits envelope events', async () => {
    const env1 = { v: WORKER_PROTOCOL_VERSION, type: 'event', id: 'e-1', seq: 1, ts: Date.now(), payload: { n: 1 } };
    const env2 = { v: WORKER_PROTOCOL_VERSION, type: 'event', id: 'e-2', seq: 2, ts: Date.now(), payload: { n: 2 } };

    const fetchMock = (input: any, init?: any) => {
      if (init?.method === 'GET' || (typeof input === 'string' && (init === undefined || init?.method === undefined))) {
        // GET path — return SSE stream with both frames, then EOF.
        return Promise.resolve(streamRes({ 'mcp-session-id': 'sh_x' }, [
          frame('e-1', 'event', env1),
          frame('e-2', 'event', env2),
        ]));
      }
      // POST path: assign session id.
      return Promise.resolve(res({ status: 202, headers: { 'mcp-session-id': 'sh_x' } }));
    };

    const c = new StreamableClient({ baseUrl: 'http://x', token: 't', fetch: fetchMock as any, setTimeoutFn: ((cb: any) => { return { unref: () => {} } as any; }) as any });
    const received: any[] = [];
    c.on('envelope', e => received.push(e));

    await c.send(envelope('heartbeat', {}));
    await c.openStream();
    // Stream reaches EOF inline; reconnect is scheduled but the
    // injected setTimeoutFn never fires, so we just observe what
    // was consumed.
    expect(received.map(e => e.id)).toEqual(['e-1', 'e-2']);
  });

  it('reconnect path sends Last-Event-ID echoing the most recent observed id', async () => {
    let getCalls = 0;
    let lastEventIdSeen: string | undefined;

    const fetchMock = (input: any, init?: any) => {
      const method = init?.method ?? 'GET';
      if (method === 'POST') {
        return Promise.resolve(res({ status: 202, headers: { 'mcp-session-id': 'sh_y' } }));
      }
      getCalls++;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      lastEventIdSeen = headers['Last-Event-ID'] ?? lastEventIdSeen;
      if (getCalls === 1) {
        // First GET delivers one frame, then EOF.
        return Promise.resolve(streamRes({ 'mcp-session-id': 'sh_y' }, [
          frame('seq-7', 'event', { v: WORKER_PROTOCOL_VERSION, type: 'event', id: 'seq-7', seq: 7, ts: Date.now(), payload: {} }),
        ]));
      }
      // Second GET (reconnect) returns empty stream; we just want to
      // observe the headers.
      return Promise.resolve(streamRes({}, []));
    };

    let scheduled: (() => void) | null = null;
    const setTimeoutFn = ((cb: any) => {
      scheduled = cb;
      return { unref: () => {} } as any;
    }) as any;

    const c = new StreamableClient({ baseUrl: 'http://x', token: 't', fetch: fetchMock as any, setTimeoutFn });
    await c.send(envelope('heartbeat', {}));
    await c.openStream();
    // First stream done; reconnect should be scheduled. Fire it.
    expect(scheduled).not.toBeNull();
    await scheduled!();
    // Ensure the reconnect's GET carried Last-Event-ID = the id we received.
    expect(lastEventIdSeen).toBe('seq-7');
  });

  it('GET 404 emits session-lost and forgets the session id', async () => {
    const fetchMock = (input: any, init?: any) => {
      const method = init?.method ?? 'GET';
      if (method === 'POST') return Promise.resolve(res({ status: 202, headers: { 'mcp-session-id': 'sh_z' } }));
      return Promise.resolve(res({ status: 404, body: 'unknown session' }));
    };
    const setTimeoutFn = ((_cb: any) => ({ unref: () => {} }) as any) as any;
    const c = new StreamableClient({ baseUrl: 'http://x', token: 't', fetch: fetchMock as any, setTimeoutFn });
    await c.send(envelope('heartbeat', {}));
    let lost = false;
    c.on('session-lost', () => { lost = true; });
    await c.openStream();
    expect(lost).toBe(true);
    expect(c.getSessionId()).toBeNull();
  });

  it('malformed SSE data emits parse-error but does not crash the consumer', async () => {
    const fetchMock = (input: any, init?: any) => {
      const method = init?.method ?? 'GET';
      if (method === 'POST') return Promise.resolve(res({ status: 202, headers: { 'mcp-session-id': 'sh_m' } }));
      return Promise.resolve(streamRes({}, [
        // Frame with non-JSON data.
        `id: bad\nevent: event\ndata: not-a-json\n\n`,
        // Frame with JSON that isn't an envelope.
        `id: also-bad\nevent: event\ndata: ${JSON.stringify({ random: 'thing' })}\n\n`,
      ]));
    };
    const c = new StreamableClient({ baseUrl: 'http://x', token: 't', fetch: fetchMock as any, setTimeoutFn: ((_cb: any) => ({ unref: () => {} }) as any) as any });
    const errs: string[] = [];
    c.on('parse-error', text => errs.push(text));
    const envelopes: unknown[] = [];
    c.on('envelope', e => envelopes.push(e));
    await c.send(envelope('heartbeat', {}));
    await c.openStream();
    expect(errs.length).toBe(2);
    expect(envelopes.length).toBe(0);
  });
});
