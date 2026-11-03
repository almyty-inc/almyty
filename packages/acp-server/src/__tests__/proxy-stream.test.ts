/**
 * An autonomous run's stream, followed across dropped connections: each
 * connection names where the last one got to (`?after=<seq>&live=<pos>`),
 * each event is yielded once and in order, an answer a retry would not
 * change (404) ends it at once, and a network error or a 5xx is retried.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { AlmytyProxy, isPermanentStatus, type StreamEvent } from '../proxy.js';

const BASE = 'https://api.test.almyty.com';
const STREAM = '/agents/a1/runs/r1/stream';

type Answer = { status: number } | { frames: string[]; breaks?: boolean };

function serve(answers: Answer[]) {
  const urls: string[] = [];
  const fetchMock = vi.fn(async (url: string) => {
    urls.push(url.replace(BASE, ''));
    const answer = answers.shift();
    if (!answer) throw new Error('no more connections expected');
    if ('status' in answer) return new Response('Run not found', { status: answer.status });
    const encoder = new TextEncoder();
    const chunks = [...answer.frames];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunks.length) controller.enqueue(encoder.encode(chunks.shift()!));
        else if (answer.breaks) controller.error(new TypeError('terminated'));
        else controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  });
  globalThis.fetch = fetchMock as any;
  return { urls, fetchMock };
}

const log = (seq: number, status = 'running') =>
  `id: ${seq}\nevent: run.log\ndata: ${JSON.stringify({ seq, type: 'step_committed', step: 0, payload: { status } })}\n\n`;
const live = (type: string, pos: string, data: Record<string, unknown> = {}) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, data, timestamp: 't', pos })}\n\n`;

async function collect(stream: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

describe('AlmytyProxy.streamRun', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('reconnects from its last seq and place, and yields each event once, then done', async () => {
    const { urls } = serve([
      { frames: [log(1), live('tool.started', '10-0', { tool: 'crm' }), log(2)], breaks: true },
      { frames: [log(2), live('tool.started', '10-0', { tool: 'crm' }), live('tool.completed', '10-1'), log(3, 'completed'), live('run.completed', '10-2')] },
    ]);
    const proxy = new AlmytyProxy(BASE, 'token');
    const events = await collect(proxy.streamRun('a1', 'r1', undefined, { retryDelaysMs: [0] }));
    expect(urls).toEqual([`${STREAM}?after=0&live=0`, `${STREAM}?after=2&live=10-0`]);
    expect(events.map((e) => e.event)).toEqual(['tool.started', 'tool.completed', 'run.completed', 'done']);
  });

  it('stops on a 404 at once, with its status, and connects no more', async () => {
    const { fetchMock } = serve([{ status: 404 }]);
    const proxy = new AlmytyProxy(BASE, 'token');
    const failure = await collect(proxy.streamRun('a1', 'r1', undefined, { retryDelaysMs: [0, 0] })).catch((e) => e);
    expect(failure).toMatchObject({ status: 404 });
    expect(isPermanentStatus(failure)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a 5xx, then carries on from where it was', async () => {
    const { urls } = serve([{ status: 503 }, { frames: [log(1, 'completed'), live('run.completed', '3-0')] }]);
    const proxy = new AlmytyProxy(BASE, 'token');
    const events = await collect(proxy.streamRun('a1', 'r1', undefined, { retryDelaysMs: [0] }));
    expect(urls).toHaveLength(2);
    expect(events.map((e) => e.event)).toEqual(['run.completed', 'done']);
  });

  it('the server ending at its time limit: straight back, its own done not taken for the run ending', async () => {
    const { urls } = serve([
      { frames: [log(1), live('llm.chunk', '4-0', { content: 'a' }), 'event: done\ndata: {}\n\n'] },
      { frames: [live('run.completed', '4-1'), log(2, 'completed')] },
    ]);
    const proxy = new AlmytyProxy(BASE, 'token');
    const events = await collect(proxy.streamRun('a1', 'r1', undefined, { retryDelaysMs: [] }));
    expect(events.map((e) => e.event)).toEqual(['llm.chunk', 'run.completed', 'done']);
    expect(urls[1]).toBe(`${STREAM}?after=1&live=4-0`);
  });

  it('a server that cannot resume: one connection, as before', async () => {
    const { fetchMock } = serve([{ frames: [`event: run.completed\ndata: ${JSON.stringify({ type: 'run.completed', data: {} })}\n\n`] }]);
    const proxy = new AlmytyProxy(BASE, 'token');
    const events = await collect(proxy.streamRun('a1', 'r1'));
    expect(events.map((e) => e.event)).toEqual(['run.completed', 'done']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
