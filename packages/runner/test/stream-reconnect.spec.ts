import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HEALTHY_STREAM_MS,
  RECONNECT_CAP_MS,
  StreamableClient,
  backoffDelay,
  envelope,
} from '../src/streamable-client.js';
import { WORKER_PROTOCOL_VERSION } from '../src/protocol.js';

/**
 * The stream loop under fake timers and a fake transport. A runner
 * flooded staging: every session-lost started one more reconnect loop,
 * so dozens ran at once, each preempting the others' streams, their
 * logged backoff never spacing anything, until the API's per-IP limiter
 * shut out everything from the owner's machine. These pin: one loop,
 * real waits, Retry-After honoured, one stream.
 */

/** A GET the test ends or breaks by hand, like a dropped connection. */
interface LiveStream {
  end(): void;
  fail(): void;
  send(text: string): void;
  closed: boolean;
}

type Answer = 'stream' | 'throw' | { status: number; body?: string; headers?: Record<string, string> };

interface FakeBackend {
  fetch: typeof globalThis.fetch;
  gets: Array<{ at: number; sessionId: string | null }>;
  streams: LiveStream[];
  /** Streams open right now; the bug had several. */
  openNow(): number;
  maxOpen(): number;
  /** What the next GETs answer; then `fallback`. */
  next: Answer[];
  fallback: Answer;
}

function fakeBackend(): FakeBackend {
  let open = 0;
  let maxOpen = 0;
  let minted = 0;
  const b: FakeBackend = {
    gets: [],
    streams: [],
    next: [],
    fallback: 'stream',
    openNow: () => open,
    maxOpen: () => maxOpen,
    fetch: (async (_url: string, init: RequestInit) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      if (init.method === 'POST') {
        minted++;
        return new Response(null, { status: 202, headers: { 'Mcp-Session-Id': `sess-${minted}` } });
      }
      b.gets.push({ at: Date.now(), sessionId: headers['Mcp-Session-Id'] ?? null });
      const answer = b.next.shift() ?? b.fallback;
      if (answer === 'throw') throw new TypeError('fetch failed');
      if (answer !== 'stream') {
        return new Response(answer.body ?? '', { status: answer.status, headers: answer.headers });
      }
      let ctrl!: ReadableStreamDefaultController<Uint8Array>;
      const live: LiveStream = {
        closed: false,
        end: () => { if (!live.closed) { live.closed = true; open--; ctrl.close(); } },
        fail: () => { if (!live.closed) { live.closed = true; open--; ctrl.error(new Error('socket hang up')); } },
        send: (text) => ctrl.enqueue(new TextEncoder().encode(text)),
      };
      const body = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
      open++;
      maxOpen = Math.max(maxOpen, open);
      b.streams.push(live);
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as any,
  };
  return b;
}

const hello = () => envelope('event', { kind: 'runner.hello' });
/** Let pending promise chains run without moving the clock. */
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('stream loop: one loop, real backoff', () => {
  let backend: FakeBackend;
  let client: StreamableClient;
  let reconnects: Array<{ attempt: number; delayMs: number; reason: string; at: number }>;

  beforeEach(() => {
    vi.useFakeTimers();
    backend = fakeBackend();
    client = new StreamableClient({ baseUrl: 'http://x', token: 't', fetch: backend.fetch, random: () => 0.5 });
    reconnects = [];
    client.on('reconnect', (r) => reconnects.push({ ...r, at: Date.now() }));
  });

  afterEach(() => {
    client.stop();
    vi.useRealTimers();
  });

  it('several end/error triggers at once start one reconnect', async () => {
    await client.send(hello());
    await client.startStream();
    expect(backend.gets).toHaveLength(1);

    // The stream drops, and in the same tick everything that used to
    // start its own loop asks for the stream again.
    backend.streams[0].fail();
    void client.startStream();
    void client.openStream();
    void client.startStream();
    await flush();
    void client.openStream();
    void client.startStream();
    await flush();

    expect(reconnects).toHaveLength(1);
    expect(backend.gets).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(reconnects[0].delayMs);
    expect(backend.gets).toHaveLength(2);
    expect(backend.openNow()).toBe(1);

    // And nothing else is queued behind it.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(backend.gets).toHaveLength(2);
  });

  it('a session-lost re-established by the daemon does not add a loop', async () => {
    // What the daemon does on session-lost: mint a session, start the stream.
    client.on('session-lost', () => {
      void (async () => {
        await client.send(hello());
        await client.startStream();
      })();
    });
    await client.send(hello());
    backend.next.push({ status: 404, body: 'unknown session' });
    await client.startStream();
    await flush();

    for (let round = 0; round < 6; round++) {
      // The stream that eventually opens is lost again, every round.
      await vi.advanceTimersByTimeAsync(RECONNECT_CAP_MS);
      const live = backend.streams.at(-1);
      backend.next.push({ status: 404, body: 'unknown session' });
      live?.end();
      await flush();
    }
    await vi.advanceTimersByTimeAsync(RECONNECT_CAP_MS);

    expect(backend.streams.length).toBeGreaterThan(3);
    expect(backend.maxOpen()).toBe(1);
    // One GET in flight at a time: consecutive GETs never share an instant.
    const times = backend.gets.map((g) => g.at);
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1]);
    // The stream never opens without a session.
    expect(backend.gets.every((g) => g.sessionId)).toBe(true);
  });

  it('spaces attempts by at least the logged delay', async () => {
    // Session lost once (the daemon re-mints), then the backend is away.
    client.on('session-lost', () => {
      void client.send(hello()).then(() => client.startStream());
    });
    await client.send(hello());
    backend.next.push({ status: 404, body: 'unknown session' });
    backend.fallback = 'throw';
    await client.startStream();
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(backend.gets.length).toBeGreaterThan(8);
    for (let i = 1; i < backend.gets.length; i++) {
      const waited = backend.gets[i].at - backend.gets[i - 1].at;
      expect(waited).toBeGreaterThanOrEqual(reconnects[i - 1].delayMs);
    }
    // Exponential, capped: no attempt is logged above the cap, the later
    // ones sit near it, and ten minutes hold a few dozen attempts at most.
    expect(Math.max(...reconnects.map((r) => r.delayMs))).toBeLessThanOrEqual(RECONNECT_CAP_MS);
    expect(reconnects.at(-1)!.delayMs).toBeGreaterThanOrEqual(RECONNECT_CAP_MS / 2);
    expect(backend.gets.length).toBeLessThan(40);
  });

  it('waits a 429 Retry-After before the next attempt', async () => {
    await client.send(hello());
    backend.next.push({ status: 429, body: 'ThrottlerException: Too Many Requests', headers: { 'Retry-After': '120' } });
    await client.startStream();
    expect(reconnects[0].delayMs).toBe(120_000);

    await vi.advanceTimersByTimeAsync(119_000);
    expect(backend.gets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(backend.gets).toHaveLength(2);
  });

  it('backs a 429 without Retry-After off at least the cap', async () => {
    await client.send(hello());
    backend.next.push({ status: 429, body: 'ThrottlerException: Too Many Requests' });
    await client.startStream();
    expect(reconnects[0].delayMs).toBeGreaterThanOrEqual(RECONNECT_CAP_MS);
    await vi.advanceTimersByTimeAsync(RECONNECT_CAP_MS - 1);
    expect(backend.gets).toHaveLength(1);
  });

  it('never holds a second concurrent stream', async () => {
    await client.send(hello());
    await client.startStream();
    for (let i = 0; i < 5; i++) {
      await client.startStream();
      void client.openStream();
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(backend.gets).toHaveLength(1);
    expect(backend.maxOpen()).toBe(1);
  });

  it('restarts the backoff only after a stream stayed up', async () => {
    await client.send(hello());
    await client.startStream();
    // Streams that drop right after opening keep backing off.
    for (let i = 0; i < 4; i++) {
      backend.streams.at(-1)!.end();
      await flush();
      await vi.advanceTimersByTimeAsync(reconnects.at(-1)!.delayMs);
    }
    expect(reconnects.map((r) => r.attempt)).toEqual([1, 2, 3, 4]);

    // One that holds for the healthy window resets it.
    await vi.advanceTimersByTimeAsync(HEALTHY_STREAM_MS);
    backend.streams.at(-1)!.end();
    await flush();
    expect(reconnects.at(-1)!.attempt).toBe(1);
  });

  it('drops a frame it has already seen, so one heartbeat is acked once', async () => {
    const acks: string[] = [];
    client.on('envelope', (env) => acks.push(env.id));
    await client.send(hello());
    await client.startStream();
    const ack = { v: WORKER_PROTOCOL_VERSION, type: 'heartbeat', id: 'hb-1', ts: 1, payload: {} };
    const frame = `id: hb-1\nevent: message\ndata: ${JSON.stringify(ack)}\n\n`;
    backend.streams[0].send(frame);
    backend.streams[0].send(frame);
    await flush();
    expect(acks).toEqual(['hb-1']);
  });
});

describe('backoffDelay', () => {
  it('doubles from 1s, caps at 30s, and jitters within the upper half', () => {
    expect(backoffDelay(1, () => 0)).toBe(500);
    expect(backoffDelay(1, () => 0.999999)).toBe(1_000);
    expect(backoffDelay(3, () => 0)).toBe(2_000);
    expect(backoffDelay(50, () => 0.999999)).toBe(RECONNECT_CAP_MS);
    expect(backoffDelay(50, () => 0)).toBe(RECONNECT_CAP_MS / 2);
  });
});
