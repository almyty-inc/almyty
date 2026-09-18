/**
 * The run-stream reducer.
 *
 * Streaming was advertised and did not happen: tokens accumulated into
 * a local variable and the transcript only learned about them once the
 * run had finished. These cover what the user must see *while* a run is
 * going, and the cost attribution that was never surfaced at all.
 */
import { describe, it, expect } from 'vitest';
import type { StreamEvent } from '@almyty/client';

import {
  addUsage,
  drain,
  finalText,
  formatCost,
  formatUsage,
  initialStreamState,
  reduceStreamEvent,
  routingFromSteps,
  type StreamState,
} from '../stream.js';

/** Events as they arrive from the client, already unwrapped. */
function ev(type: string, data: Record<string, unknown> = {}): StreamEvent {
  return { type, data };
}

function fold(events: StreamEvent[], start: StreamState = initialStreamState()): StreamState {
  return events.reduce(reduceStreamEvent, start);
}

describe('token streaming', () => {
  it('accumulates chunks into text available before the run ends', () => {
    const s = fold([
      ev('llm.started', { step: 1 }),
      ev('llm.chunk', { content: 'Rome ' }),
      ev('llm.chunk', { content: 'is the ' }),
      ev('llm.chunk', { content: 'capital.' }),
    ]);
    expect(s.partial).toBe('Rome is the capital.');
    expect(s.done).toBe(false);
  });

  it('uses the response body when the provider does not stream tokens', () => {
    const s = fold([ev('llm.started'), ev('llm.response', { content: 'One shot answer.' })]);
    expect(s.partial).toBe('One shot answer.');
  });

  it('does not double the answer when both chunks and a body arrive', () => {
    const s = fold([
      ev('llm.chunk', { content: 'Hello' }),
      ev('llm.response', { content: 'Hello' }),
    ]);
    expect(s.partial).toBe('Hello');
  });
});

describe('visible progress', () => {
  it('shows a tool call, its result and a label while it runs', () => {
    let s = reduceStreamEvent(initialStreamState(), ev('tool.started', { tool: 'search_orders' }));
    expect(s.label).toBe('Running search_orders');
    expect(s.emit).toEqual([{ role: 'tool', text: 'search_orders' }]);

    s = reduceStreamEvent(s, ev('tool.result', { tool: 'search_orders', success: true, executionTime: 1400 }));
    expect(s.emit[1]).toEqual({ role: 'info', text: 'search_orders ok 1.4s' });
  });

  it('marks a failed tool as an error, not an info line', () => {
    const s = reduceStreamEvent(initialStreamState(), ev('tool.result', { tool: 'charge', success: false }));
    expect(s.emit[0].role).toBe('error');
    expect(s.emit[0].text).toContain('failed');
  });

  it('flushes the preamble before a tool call so the text is not lost', () => {
    const s = fold([
      ev('llm.chunk', { content: 'Let me look that up.' }),
      ev('llm.response', { content: 'Let me look that up.', toolCalls: [{ id: '1', name: 'search' }] }),
    ]);
    expect(s.emit).toEqual([{ role: 'agent', text: 'Let me look that up.' }]);
    // The next step starts with an empty buffer, not the preamble.
    expect(s.partial).toBe('');
  });

  it('reports each pipeline node of a workflow agent', () => {
    const s = fold([
      ev('execution.started', {}),
      ev('node.started', { nodeId: 'llm_1', nodeType: 'llm_call' }),
      ev('node.completed', { nodeId: 'llm_1', cost: 0.002, tokens: 120 }),
      ev('node.skipped', { nodeId: 'branch_b' }),
      ev('execution.completed', { output: 'done', totalCost: 0, totalTokens: 0 }),
    ]);
    expect(s.emit.map(a => a.text)).toEqual(['llm_call · llm_1', 'branch_b skipped']);
    expect(s.usage.cost).toBeCloseTo(0.002, 6);
    expect(s.usage.tokens).toBe(120);
    expect(s.done).toBe(true);
    expect(s.output).toBe('done');
  });

  it('labels a run that is waiting on the user', () => {
    const s = reduceStreamEvent(initialStreamState(), ev('step.completed', { status: 'waiting_input' }));
    expect(s.label).toBe('Waiting for your input');
    expect(s.usage.steps).toBe(1);
  });

  it('says when a verifier sent the draft back', () => {
    const s = reduceStreamEvent(initialStreamState(), ev('verify.failed', {}));
    expect(s.emit[0].text).toContain('revising');
  });
});

describe('cost and model attribution', () => {
  it('tallies cost and tokens across steps', () => {
    const s = fold([
      ev('llm.response', { content: 'a', cost: 0.0012, usage: { inputTokens: 100, outputTokens: 20 } }),
      ev('llm.response', { content: 'b', cost: 0.0008, usage: { inputTokens: 50, outputTokens: 10 } }),
    ]);
    expect(s.usage.cost).toBeCloseTo(0.002, 6);
    expect(s.usage.tokens).toBe(180);
  });

  it('records which model answered when the event carries routing', () => {
    const s = reduceStreamEvent(
      initialStreamState(),
      ev('llm.response', { content: 'x', routing: { vendorModelId: 'claude-sonnet-4', rationale: 'cheapest', attempt: 2 } }),
    );
    expect(s.usage.model).toBe('claude-sonnet-4');
    expect(s.usage.attempt).toBe(2);
    expect(formatUsage(s.usage)).toContain('claude-sonnet-4 (attempt 2)');
  });

  it('reads routing off a finished run when the stream did not carry it', () => {
    const routing = routingFromSteps([
      { type: 'llm_call', output: {} },
      { type: 'llm_call', output: { routing: { vendorModelId: 'gpt-4o', rationale: 'fastest', attempt: 1 } } },
    ]);
    expect(routing).toEqual({ model: 'gpt-4o', rationale: 'fastest', attempt: 1 });
    expect(routingFromSteps([{ type: 'llm_call', output: {} }])).toBeNull();
    expect(routingFromSteps(undefined)).toBeNull();
  });

  it('never rounds a real cost away to nothing', () => {
    expect(formatCost(0.0004)).toBe('$0.0004');
    expect(formatCost(0.42)).toBe('$0.420');
    expect(formatCost(3.5)).toBe('$3.50');
    expect(formatCost(0)).toBe('$0');
  });

  it('formats one attribution line', () => {
    expect(formatUsage({ cost: 0.0042, tokens: 1284, steps: 3, model: 'gpt-4o' }))
      .toBe('gpt-4o · 1,284 tok · $0.0042 · 3 steps');
    expect(formatUsage({ cost: 0, tokens: 0, steps: 0 })).toBe('');
  });

  it('sums turns into a session total', () => {
    const total = addUsage({ cost: 0.01, tokens: 100, steps: 1 }, { cost: 0.02, tokens: 50, steps: 2, model: 'gpt-4o' });
    expect(total.cost).toBeCloseTo(0.03, 6);
    expect(total.tokens).toBe(150);
    expect(total.steps).toBe(3);
    expect(total.model).toBe('gpt-4o');
  });
});

describe('terminal states', () => {
  it('a completed run carries its output', () => {
    const s = reduceStreamEvent(initialStreamState(), ev('run.completed', { output: 'the answer' }));
    expect(s.done).toBe(true);
    expect(finalText(s)).toBe('the answer');
  });

  it('prefers what the user already watched arrive', () => {
    const s = fold([ev('llm.chunk', { content: 'streamed' }), ev('run.completed', { output: 'streamed' })]);
    expect(finalText(s)).toBe('streamed');
  });

  it('serialises a structured output', () => {
    const s = reduceStreamEvent(initialStreamState(), ev('run.completed', { output: { ok: true } }));
    expect(finalText(s)).toContain('"ok": true');
  });

  it('a failed run carries the reason', () => {
    const s = reduceStreamEvent(initialStreamState(), ev('run.failed', { error: 'tool blew up' }));
    expect(s.failed).toBe('tool blew up');
    expect(s.done).toBe(true);
  });

  it('a cancelled run is marked cancelled, not failed', () => {
    const s = reduceStreamEvent(initialStreamState(), ev('run.cancelled', {}));
    expect(s.cancelled).toBe(true);
    expect(s.failed).toBeUndefined();
  });

  it('ignores an event type it does not know', () => {
    const s = reduceStreamEvent(initialStreamState(), ev('something.new', { x: 1 }));
    expect(s.emit).toEqual([]);
    expect(s.done).toBe(false);
  });
});

describe('drain', () => {
  it('hands over pending lines once', () => {
    const s = reduceStreamEvent(initialStreamState(), ev('tool.started', { tool: 't' }));
    const first = drain(s);
    expect(first.activities).toHaveLength(1);
    expect(drain(first.state).activities).toHaveLength(0);
  });
});
