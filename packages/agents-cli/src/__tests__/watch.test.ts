/**
 * `run --watch`, against a real AlmytyClient over a scripted fetch: each
 * step printed once as its commit lands, a dropped connection picked up
 * after the last logged event it had, a run that is gone ending it at once.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AlmytyClient } from '@almyty/client';

import { applyLogToSteps, watchRun } from '../watch.js';

const BASE = 'https://api.test.almyty.com';
const STREAM = '/agents/a1/runs/r1/stream';

type Answer = { status: number } | { frames: string[]; breaks?: boolean };

function serve(answers: Answer[], finalRun: Record<string, unknown> = { id: 'r1', status: 'completed', steps: [] }) {
  const streamUrls: string[] = [];
  const fetchMock = vi.fn(async (url: string) => {
    if (!url.includes('/stream')) return { ok: true, status: 200, json: async () => ({ data: finalRun }), text: async () => '' };
    streamUrls.push(url.replace(BASE, ''));
    const answer = answers.shift();
    if (!answer) throw new Error('no more connections expected');
    if ('status' in answer) return { ok: false, status: answer.status, text: async () => 'Run not found', body: null };
    const encoder = new TextEncoder();
    const chunks = [...answer.frames];
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            if (chunks.length) return { value: encoder.encode(chunks.shift()!), done: false };
            if (answer.breaks) throw new TypeError('terminated');
            return { value: undefined, done: true };
          },
          cancel: async () => undefined,
          releaseLock: () => undefined,
        }),
      },
    };
  });
  globalThis.fetch = fetchMock as any;
  return { streamUrls, fetchMock };
}

const frame = (seq: number, type: string, payload: Record<string, unknown>) =>
  `id: ${seq}\nevent: run.log\ndata: ${JSON.stringify({ seq, type, step: 0, payload })}\n\n`;
const toolStep = (i: number) => ({ type: 'tool_call', input: { tool: `crm_${i}` }, output: { ok: i } });

describe('run --watch', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('prints each step once as its commit lands, across a dropped connection', async () => {
    const { streamUrls } = serve(
      [
        {
          frames: [
            frame(1, 'run_started', { status: 'running', steps: [] }),
            frame(2, 'tool_call', { index: 0, step: toolStep(0) }),
            frame(3, 'step_committed', { status: 'running' }),
            frame(4, 'tool_call', { index: 1, step: toolStep(1) }),
          ],
          breaks: true,
        },
        {
          frames: [
            frame(4, 'tool_call', { index: 1, step: toolStep(1) }),
            frame(5, 'tool_result', { index: 1, result: { output: { ok: 'done' } } }),
            frame(6, 'step_committed', { status: 'completed' }),
          ],
        },
      ],
      { id: 'r1', status: 'completed', steps: [toolStep(0), { ...toolStep(1), output: { ok: 'done' } }] },
    );
    const printed: Array<[unknown, number]> = [];
    const run = await watchRun(new AlmytyClient(BASE, 't'), 'a1', 'r1', {
      timeoutMs: 5_000,
      onStep: (step, i) => printed.push([step, i]),
      retryDelaysMs: [0],
    });
    expect(streamUrls).toEqual([`${STREAM}?after=0&live=0`, `${STREAM}?after=4&live=0`]);
    expect(printed.map(([, i]) => i)).toEqual([0, 1]);
    expect(printed[1][0]).toEqual({ ...toolStep(1), output: { ok: 'done' } });
    expect(run.status).toBe('completed');
  });

  it('a run that is gone: the watch ends at once with the 404, no polling', async () => {
    const { fetchMock } = serve([{ status: 404 }]);
    await expect(
      watchRun(new AlmytyClient(BASE, 't'), 'a1', 'r1', { timeoutMs: 5_000, onStep: () => undefined, retryDelaysMs: [0, 0] }),
    ).rejects.toMatchObject({ status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops when the run waits on a person, as the polling watch did', async () => {
    serve(
      [{ frames: [frame(1, 'run_started', { status: 'running', steps: [] }), frame(2, 'step_committed', { status: 'waiting_input' })] }],
      { id: 'r1', status: 'waiting_input', steps: [] },
    );
    const run = await watchRun(new AlmytyClient(BASE, 't'), 'a1', 'r1', { timeoutMs: 5_000, onStep: () => undefined });
    expect(run.status).toBe('waiting_input');
  });

  it('a server without the run log: the steps come from the run as it ended', async () => {
    serve([{ frames: [`event: run.completed\ndata: ${JSON.stringify({ type: 'run.completed', data: {} })}\n\n`] }], {
      id: 'r1',
      status: 'completed',
      steps: [toolStep(0)],
    });
    const printed: number[] = [];
    await watchRun(new AlmytyClient(BASE, 't'), 'a1', 'r1', { timeoutMs: 5_000, onStep: (_s, i) => printed.push(i) });
    expect(printed).toEqual([0]);
  });

  it('applyLogToSteps folds a tool call and its result into one step', () => {
    let steps: unknown[] = [];
    steps = applyLogToSteps(steps, { seq: 1, type: 'tool_call', step: 0, payload: { index: 0, step: toolStep(0) } });
    steps = applyLogToSteps(steps, { seq: 2, type: 'tool_result', step: 0, payload: { index: 0, result: { output: 'r', duration: 3 } } });
    steps = applyLogToSteps(steps, { seq: 3, type: 'memory_changed', step: 0, payload: { set: { a: 1 } } });
    expect(steps).toEqual([{ ...toolStep(0), output: 'r', duration: 3 }]);
  });
});
