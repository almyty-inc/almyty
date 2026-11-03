/**
 * A run's stream, followed across dropped connections.
 *
 * Every connection names where the last one got to (`?after=<seq>` for
 * the run's log, `?live=<pos>` for its runtime events); each event reaches
 * the caller once and in order; an answer a retry would not change (404)
 * ends it at once; a network error or a 5xx is retried.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { AlmytyClient, isPermanentStreamError } from '../client.js';
import type { RunLogEvent, StreamEvent } from '../client.js';

const BASE = 'https://api.test.almyty.com';

/** What one connection answers: a status, or frames and then an end or a break. */
type Answer = { status: number } | { frames: string[]; breaks?: boolean };

function serve(answers: Answer[]) {
  const urls: string[] = [];
  const fetchMock = vi.fn(async (url: string) => {
    urls.push(url);
    const answer = answers.shift();
    if (!answer) throw new Error('no more connections expected');
    if ('status' in answer) {
      return { ok: false, status: answer.status, text: async () => 'nope', body: null };
    }
    const encoder = new TextEncoder();
    const chunks = [...answer.frames];
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            if (chunks.length) return { value: encoder.encode(chunks.shift()!), done: false };
            if (answer.breaks) throw Object.assign(new TypeError('terminated'), { cause: { code: 'ECONNRESET' } });
            return { value: undefined, done: true };
          },
          cancel: async () => undefined,
          releaseLock: () => undefined,
        }),
      },
    };
  });
  globalThis.fetch = fetchMock as any;
  return { urls, fetchMock };
}

const log = (seq: number, type = 'step_committed', payload: Record<string, unknown> = { status: 'running' }) =>
  `id: ${seq}\nevent: run.log\ndata: ${JSON.stringify({ seq, type, step: 0, payload })}\n\n`;
const live = (type: string, pos: string, data: Record<string, unknown> = {}) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, data, timestamp: 't', pos })}\n\n`;
const query = (url: string) => url.slice(url.indexOf('?'));

describe('AlmytyClient.followRunStream', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('reconnects from the last seq and place it had, and hands on each event once', async () => {
    const { urls } = serve([
      { frames: [log(1), live('llm.chunk', '100-0', { content: 'Your ' }), log(2), live('llm.chunk', '100-1', { content: 'order ' })], breaks: true },
      {
        // The server picks up after both; anything it repeats is not handed on twice.
        frames: [log(2), live('llm.chunk', '100-1', { content: 'order ' }), live('llm.chunk', '100-2', { content: 'ships.' }), log(3, 'step_committed', { status: 'completed' }), live('run.completed', '100-3')],
      },
    ]);
    const client = new AlmytyClient(BASE, 'token');
    const events: StreamEvent[] = [];
    const logged: RunLogEvent[] = [];
    const reconnects: any[] = [];

    const at = await client.followRunStream('/agents/a1/runs/r1/stream', (e) => events.push(e), undefined, {
      onLog: (e) => logged.push(e),
      onReconnect: (info) => reconnects.push(info),
      retryDelaysMs: [0, 0],
    });

    expect(urls.map(query)).toEqual(['?after=0&live=0', '?after=2&live=100-1']);
    expect(events.map((e) => e.type)).toEqual(['llm.chunk', 'llm.chunk', 'llm.chunk', 'run.completed']);
    expect(events.map((e) => e.data.content).filter(Boolean).join('')).toBe('Your order ships.');
    expect(logged.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(at).toEqual({ afterSeq: 3, livePos: '100-3' });
    expect(reconnects).toHaveLength(1);
  });

  it('starts from a position the caller already has', async () => {
    const { urls } = serve([{ frames: [log(8, 'step_committed', { status: 'completed' }), live('run.completed', '9-0')] }]);
    const client = new AlmytyClient(BASE, 'token');
    await client.followRunStream('/agents/a1/runs/r1/stream', () => undefined, undefined, { afterSeq: 7, livePos: '8-3' });
    expect(query(urls[0])).toBe('?after=7&live=8-3');
  });

  it('stops on a 404 at once: no retry, no second connection', async () => {
    const { fetchMock } = serve([{ status: 404 }]);
    const client = new AlmytyClient(BASE, 'token');
    const failure = await client.followRunStream('/agents/a1/runs/gone/stream', () => undefined, undefined, { retryDelaysMs: [0, 0, 0] }).catch((e) => e);
    expect(failure).toMatchObject({ status: 404 });
    expect(isPermanentStreamError(failure)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 403, 410])('stops on a %i the same way', async (status) => {
    const { fetchMock } = serve([{ status }]);
    const client = new AlmytyClient(BASE, 'token');
    await expect(client.followRunStream('/agents/a1/runs/r1/stream', () => undefined, undefined, { retryDelaysMs: [0] })).rejects.toMatchObject({ status });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a 5xx with backoff, then carries on', async () => {
    const { urls } = serve([{ status: 503 }, { status: 502 }, { frames: [log(1, 'step_committed', { status: 'completed' }), live('run.completed', '1-0')] }]);
    const client = new AlmytyClient(BASE, 'token');
    const delays: number[] = [];
    await client.followRunStream('/agents/a1/runs/r1/stream', () => undefined, undefined, {
      retryDelaysMs: [1, 2, 3],
      onReconnect: (info) => delays.push(info.delayMs),
    });
    expect(urls).toHaveLength(3);
    expect(delays).toEqual([1, 2]);
  });

  it('gives up after its retries, with the last failure', async () => {
    serve([{ status: 503 }, { status: 503 }, { status: 503 }]);
    const client = new AlmytyClient(BASE, 'token');
    await expect(client.followRunStream('/agents/a1/runs/r1/stream', () => undefined, undefined, { retryDelaysMs: [0, 0] })).rejects.toMatchObject({ status: 503 });
  });

  it('a logged event that skips ahead: reconnects from the last one applied', async () => {
    const { urls } = serve([
      { frames: [log(1), log(3)] },
      { frames: [log(2), log(3, 'step_committed', { status: 'completed' })] },
    ]);
    const client = new AlmytyClient(BASE, 'token');
    const seqs: number[] = [];
    await client.followRunStream('/agents/a1/runs/r1/stream', () => undefined, undefined, { onLog: (e) => seqs.push(e.seq), retryDelaysMs: [0] });
    expect(seqs).toEqual([1, 2, 3]);
    expect(query(urls[1])).toBe('?after=1&live=0');
  });

  it('the server ending at its time limit, the run still going: straight back from where it was', async () => {
    const { urls } = serve([
      { frames: [log(1), live('llm.chunk', '5-0', { content: 'a' }), `event: stream.timeout\ndata: ${JSON.stringify({ type: 'stream.timeout', data: { lastSeq: 1 } })}\n\n`, 'event: done\ndata: {}\n\n'] },
      { frames: [live('run.completed', '6-0'), log(2, 'step_committed', { status: 'completed' })] },
    ]);
    const client = new AlmytyClient(BASE, 'token');
    const types: string[] = [];
    await client.followRunStream('/agents/a1/runs/r1/stream', (e) => types.push(e.type), undefined, { retryDelaysMs: [] });
    // Neither the time limit nor the server's own `done` reaches the caller as the run's end.
    expect(types).toEqual(['llm.chunk', 'run.completed']);
    expect(query(urls[1])).toBe('?after=1&live=5-0');
  });

  it('a server that cannot resume (no seq, no place): one connection, as before', async () => {
    const { fetchMock } = serve([{ frames: [`event: run.completed\ndata: ${JSON.stringify({ type: 'run.completed', data: { output: 'x' } })}\n\n`] }]);
    const client = new AlmytyClient(BASE, 'token');
    const types: string[] = [];
    await client.followRunStream('/agents/a1/runs/r1/stream', (e) => types.push(e.type));
    expect(types).toEqual(['run.completed']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stopOnWaitingInput: returns once the log shows the run waiting on a person', async () => {
    serve([{ frames: [log(1), log(2, 'step_committed', { status: 'waiting_input' })] }]);
    const client = new AlmytyClient(BASE, 'token');
    const at = await client.followRunStream('/agents/a1/runs/r1/stream', () => undefined, undefined, { stopOnWaitingInput: true });
    expect(at.afterSeq).toBe(2);
  });
});

describe('GatewayClient.streamRun', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('resumes from its last seq and place on the gateway route', async () => {
    const { urls } = serve([
      { frames: [log(4), live('llm.chunk', '7-0', { content: 'hi' })], breaks: true },
      { frames: [live('run.completed', '7-1'), log(5, 'step_committed', { status: 'completed' })] },
    ]);
    // getRun after the stream.
    const streamFetch = globalThis.fetch as any;
    globalThis.fetch = vi.fn(async (url: string, init?: any) =>
      url.includes('/stream')
        ? streamFetch(url, init)
        : { ok: true, status: 200, json: async () => ({ data: { id: 'r1', status: 'completed' } }), text: async () => '' },
    ) as any;
    const gw = new AlmytyClient(BASE, 'token').gateway('acme', 'support');
    const run = await gw.streamRun('r1', () => undefined, undefined, { afterSeq: 3, retryDelaysMs: [0] });
    expect(run.status).toBe('completed');
    expect(urls.map((u) => u.replace(BASE, ''))).toEqual(['/acme/support/runs/r1/stream?after=3&live=0', '/acme/support/runs/r1/stream?after=4&live=7-0']);
  });

  it('stops on a 404 instead of polling a run that is gone', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404, text: async () => 'Run not found', body: null }));
    globalThis.fetch = fetchMock as any;
    const gw = new AlmytyClient(BASE, 'token').gateway('acme', 'support');
    await expect(gw.streamRun('r1', () => undefined)).rejects.toMatchObject({ status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
