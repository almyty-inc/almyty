/**
 * One turn, end to end, against a fake gateway.
 *
 * The behaviours under test are the ones that were missing: the answer
 * is visible while it arrives, a tool call is announced as it starts,
 * Ctrl-C cancels the run *server-side* rather than only killing the
 * client, and a workflow agent's pipeline is streamed rather than
 * blocked on.
 */
import { describe, it, expect, vi } from 'vitest';
import type { AgentRun, StreamEvent } from '@almyty/client';

import { runTurn, type TurnTarget } from '../turn.js';
import { EXIT, exitCodeForStatus } from '../exit-codes.js';
import type { Activity } from '../stream.js';

type Script = Array<{ type: string; data?: Record<string, unknown> }>;

interface FakeOptions {
  script?: Script;
  final?: Partial<AgentRun>;
  /** Throw this from streamRun instead of playing the script. */
  streamError?: unknown;
  invokeResult?: unknown;
  invokeStreamError?: unknown;
}

function fakeGateway(options: FakeOptions = {}) {
  const calls = {
    startRun: 0,
    cancelRun: [] as string[],
    sendRunInput: [] as Array<[string, string]>,
    invoke: 0,
    streamInvoke: 0,
  };

  const target: TurnTarget = {
    async startRun() {
      calls.startRun++;
      return { id: 'run_1', status: 'running', conversationId: 'conv_1' } as AgentRun;
    },
    async streamRun(runId, handler) {
      if (options.streamError) throw options.streamError;
      for (const event of options.script ?? []) handler({ type: event.type, data: event.data ?? {} } as StreamEvent);
      return { id: runId, status: 'completed', ...options.final } as AgentRun;
    },
    async streamInvoke(_input, handler) {
      calls.streamInvoke++;
      if (options.invokeStreamError) throw options.invokeStreamError;
      for (const event of options.script ?? []) handler({ type: event.type, data: event.data ?? {} } as StreamEvent);
    },
    async invoke() {
      calls.invoke++;
      return options.invokeResult;
    },
    async sendRunInput(runId, input) { calls.sendRunInput.push([runId, input]); },
    async cancelRun(runId) { calls.cancelRun.push(runId); },
  };

  return { target, calls };
}

describe('autonomous turn', () => {
  it('streams the answer to the hook as it arrives, not at the end', async () => {
    const { target } = fakeGateway({
      script: [
        { type: 'llm.chunk', data: { content: 'Rome ' } },
        { type: 'llm.chunk', data: { content: 'is it.' } },
        { type: 'run.completed', data: { output: 'Rome is it.' } },
      ],
    });
    const partials: string[] = [];
    const result = await runTurn(target, 'capital?', { mode: 'autonomous', hooks: { partial: (t) => partials.push(t) } });

    expect(partials).toEqual(['Rome ', 'Rome is it.']);
    expect(result.status).toBe('completed');
    expect(result.text).toBe('Rome is it.');
    expect(result.conversationId).toBe('conv_1');
  });

  it('announces tool calls and step labels while the run is going', async () => {
    const { target } = fakeGateway({
      script: [
        { type: 'tool.started', data: { tool: 'lookup' } },
        { type: 'tool.result', data: { tool: 'lookup', success: true } },
        { type: 'run.completed', data: { output: 'done' } },
      ],
    });
    const activities: Activity[] = [];
    const labels: string[] = [];
    await runTurn(target, 'q', { mode: 'autonomous', hooks: { activity: (a) => activities.push(a), label: (l) => labels.push(l) } });

    expect(activities.map(a => a.text)).toEqual(['lookup', 'lookup ok']);
    expect(labels).toContain('Running lookup');
  });

  it('cancels the run server-side when the caller aborts', async () => {
    const abort = Object.assign(new Error('Aborted'), { name: 'AbortError' });
    const { target, calls } = fakeGateway({ streamError: abort });
    const ac = new AbortController();
    ac.abort();

    const result = await runTurn(target, 'q', { mode: 'autonomous', signal: ac.signal });

    expect(result.status).toBe('cancelled');
    // The whole point: the run is stopped where it runs, not just
    // where it was being watched.
    expect(calls.cancelRun).toEqual(['run_1']);
  });

  it('holds the run open when the agent asks a question', async () => {
    const { target } = fakeGateway({
      script: [{ type: 'step.completed', data: { status: 'waiting_input' } }],
      final: { status: 'waiting_input' },
    });
    const result = await runTurn(target, 'q', { mode: 'autonomous' });
    expect(result.status).toBe('waiting_input');
    expect(result.pendingRunId).toBe('run_1');
    expect(exitCodeForStatus(result.status)).toBe(EXIT.OK);
  });

  it('answers a waiting run instead of starting another one', async () => {
    const { target, calls } = fakeGateway({ script: [{ type: 'run.completed', data: { output: 'ok' } }] });
    await runTurn(target, 'yes', { mode: 'autonomous', pendingRunId: 'run_9' });
    expect(calls.startRun).toBe(0);
    expect(calls.sendRunInput).toEqual([['run_9', 'yes']]);
  });

  it('a failed run is a failed turn, and earns the shared failure code', async () => {
    const { target } = fakeGateway({
      script: [{ type: 'run.failed', data: { error: 'tool blew up' } }],
      final: { status: 'failed', error: 'tool blew up' },
    });
    const result = await runTurn(target, 'q', { mode: 'autonomous' });
    expect(result.status).toBe('failed');
    expect(result.error).toBe('tool blew up');
    expect(exitCodeForStatus(result.status)).toBe(EXIT.FAILED);
  });

  it('rethrows a real failure rather than reporting a cancellation', async () => {
    const { target, calls } = fakeGateway({ streamError: Object.assign(new Error('API error 500: boom'), { status: 500 }) });
    await expect(runTurn(target, 'q', { mode: 'autonomous' })).rejects.toThrow('boom');
    expect(calls.cancelRun).toEqual([]);
  });

  it('falls back to the persisted totals when the stream missed them', async () => {
    const { target } = fakeGateway({
      script: [{ type: 'run.completed', data: { output: 'ok' } }],
      final: { status: 'completed', totalCost: 0.05, totalTokens: 900, steps: [{ type: 'llm_call', output: { routing: { vendorModelId: 'gpt-4o' } } }] },
    });
    const result = await runTurn(target, 'q', { mode: 'autonomous' });
    expect(result.usage.cost).toBeCloseTo(0.05, 6);
    expect(result.usage.tokens).toBe(900);
    expect(result.usage.model).toBe('gpt-4o');
  });
});

describe('workflow turn', () => {
  it('streams the pipeline so each node is visible', async () => {
    const { target, calls } = fakeGateway({
      script: [
        { type: 'node.started', data: { nodeId: 'in', nodeType: 'input' } },
        { type: 'node.started', data: { nodeId: 'llm', nodeType: 'llm_call' } },
        { type: 'execution.completed', data: { output: 'pipeline answer', totalCost: 0.004, totalTokens: 300 } },
      ],
    });
    const activities: Activity[] = [];
    const result = await runTurn(target, 'go', { mode: 'workflow', hooks: { activity: (a) => activities.push(a) } });

    expect(calls.streamInvoke).toBe(1);
    expect(calls.invoke).toBe(0);
    expect(activities.map(a => a.text)).toEqual(['input · in', 'llm_call · llm']);
    expect(result.text).toBe('pipeline answer');
    expect(result.usage.cost).toBeCloseTo(0.004, 6);
  });

  it('falls back to the blocking call where the stream endpoint is absent', async () => {
    const { target, calls } = fakeGateway({
      invokeStreamError: Object.assign(new Error('SSE 404: Unknown agent action: stream'), { status: 404 }),
      invokeResult: { output: 'blocking answer' },
    });
    const result = await runTurn(target, 'go', { mode: 'workflow' });
    expect(calls.invoke).toBe(1);
    expect(result.text).toBe('blocking answer');
    expect(result.status).toBe('completed');
  });

  it('does not swallow a real streaming failure as a missing endpoint', async () => {
    const { target, calls } = fakeGateway({
      invokeStreamError: Object.assign(new Error('SSE 500: boom'), { status: 500 }),
    });
    await expect(runTurn(target, 'go', { mode: 'workflow' })).rejects.toThrow('boom');
    expect(calls.invoke).toBe(0);
  });

  it('reports a failed pipeline', async () => {
    const { target } = fakeGateway({ script: [{ type: 'execution.failed', data: { error: 'node exploded' } }] });
    const result = await runTurn(target, 'go', { mode: 'workflow' });
    expect(result.status).toBe('failed');
    expect(result.error).toBe('node exploded');
  });
});

describe('exitCodeForStatus', () => {
  it('only a completed or waiting turn is a success', () => {
    expect(exitCodeForStatus('completed')).toBe(EXIT.OK);
    expect(exitCodeForStatus('waiting_input')).toBe(EXIT.OK);
  });

  it('a run that ran and failed is 5, not 1, so a script can tell them apart', () => {
    expect(exitCodeForStatus('failed')).toBe(EXIT.FAILED);
    expect(exitCodeForStatus('cancelled')).toBe(EXIT.FAILED);
    expect(EXIT.FAILED).not.toBe(EXIT.ERROR);
  });
});
