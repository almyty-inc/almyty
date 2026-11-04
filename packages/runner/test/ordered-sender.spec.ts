import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { OrderedSender, isRetryable } from '../src/ordered-sender.js';
import { StreamableClient, BackendPostError, envelope } from '../src/streamable-client.js';
import type { WorkerEnvelope } from '../src/protocol.js';

/**
 * Coding output goes to the backend one POST at a time, each after the
 * answer to the one before: the backend answers once the event is in the
 * session's stream, so this is what keeps the stream in the order the
 * output was produced when POSTs land on different pods. A POST that fails
 * in a way that can pass is sent again with the same envelope.
 */

function deferred() {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setImmediate(r));
const out = (n: number) => envelope('event', { kind: 'coding.output', sessionId: 'cs_1', data: `line ${n}\n`, seq: n });
const seqOf = (env: WorkerEnvelope) => (env.payload as { seq: number }).seq;

describe('OrderedSender', () => {
  it('sends one envelope at a time, in order, each after the previous answer', async () => {
    const answers: Array<ReturnType<typeof deferred>> = [];
    const started: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const sender = new OrderedSender({
      send: async (env) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        started.push(seqOf(env));
        const d = deferred();
        answers.push(d);
        await d.promise;
        inFlight -= 1;
      },
    });

    for (let n = 1; n <= 3; n++) sender.enqueue(out(n));
    await flush();
    expect(started).toEqual([1]); // 2 and 3 wait for 1's answer
    answers[0].resolve();
    await flush();
    expect(started).toEqual([1, 2]);
    answers[1].resolve();
    await flush();
    answers[2].resolve();
    await sender.idle();

    expect(started).toEqual([1, 2, 3]);
    expect(maxInFlight).toBe(1);
    expect(sender.pending).toBe(0);
  });

  it('retries a 503 with the same envelope before sending the next one', async () => {
    const posted: WorkerEnvelope[] = [];
    let failures = 2;
    const fetchStub = (async (_url: string, init: RequestInit) => {
      posted.push(JSON.parse(String(init.body)));
      if (failures > 0) {
        failures -= 1;
        return new Response(JSON.stringify({ error: 'envelope not recorded' }), { status: 503 });
      }
      return new Response(null, { status: 202, headers: { 'mcp-session-id': 'sh_1' } });
    }) as unknown as typeof fetch;
    const client = new StreamableClient({ baseUrl: 'http://x', token: 't', fetch: fetchStub });
    const delays: number[] = [];
    const dropped: unknown[] = [];
    const sender = new OrderedSender({
      send: (env) => client.send(env),
      sleep: async (ms) => { delays.push(ms); },
      onDrop: (_env, err) => dropped.push(err),
    });

    const one = out(1);
    const two = out(2);
    sender.enqueue(one);
    sender.enqueue(two);
    await sender.idle();

    // 1 three times (two 503s, then 202), then 2 once: nothing overtakes a retry.
    expect(posted.map(seqOf)).toEqual([1, 1, 1, 2]);
    // Each retry is the same envelope, so the backend can tell it from new output.
    expect(posted.slice(0, 3).every((e) => e.id === one.id)).toBe(true);
    expect(posted[3].id).toBe(two.id);
    expect(delays).toEqual([250, 500]);
    expect(dropped).toEqual([]);
  });

  it('retries when there is no answer at all', async () => {
    let calls = 0;
    const sent: number[] = [];
    const sender = new OrderedSender({
      send: async (env) => {
        calls += 1;
        if (calls === 1) throw new TypeError('fetch failed');
        sent.push(seqOf(env));
      },
      sleep: async () => undefined,
    });
    sender.enqueue(out(1));
    sender.enqueue(out(2));
    await sender.idle();
    expect(sent).toEqual([1, 2]);
  });

  it('drops an envelope the backend refused, or one still failing after the last retry, and moves on', async () => {
    const sent: number[] = [];
    const dropped: number[] = [];
    const sender = new OrderedSender({
      retryDelaysMs: [1, 1],
      sleep: async () => undefined,
      send: async (env) => {
        const n = seqOf(env);
        if (n === 1) throw new BackendPostError(400, 'invalid envelope');
        if (n === 2) throw new BackendPostError(503, 'down');
        sent.push(n);
      },
      onDrop: (env) => dropped.push(seqOf(env)),
    });
    for (let n = 1; n <= 3; n++) sender.enqueue(out(n));
    await sender.idle();
    expect(dropped).toEqual([1, 2]);
    expect(sent).toEqual([3]);
  });

  it('classifies failures', () => {
    expect(isRetryable(new TypeError('fetch failed'))).toBe(true);
    expect(isRetryable(new BackendPostError(503, ''))).toBe(true);
    expect(isRetryable(new BackendPostError(429, ''))).toBe(true);
    expect(isRetryable(new BackendPostError(404, 'unknown session'))).toBe(true);
    expect(isRetryable(new BackendPostError(400, ''))).toBe(false);
    expect(isRetryable(new BackendPostError(401, ''))).toBe(false);
  });

  it('the daemon sends coding output through the ordered sender', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/daemon.ts', import.meta.url)), 'utf-8');
    const wiring = src.slice(src.indexOf('new CodingSessionManager('));
    const emitter = wiring.slice(0, wiring.indexOf('});') + 3);
    expect(emitter).toContain('codingSender.enqueue(envelope(');
    expect(emitter).not.toMatch(/client\??\.send\(/);
  });
});
