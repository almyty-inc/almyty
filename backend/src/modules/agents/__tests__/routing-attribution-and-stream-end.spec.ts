import { readFileSync } from 'fs';
import { join } from 'path';

import { AgentRuntimeEventsHelper } from '../agent-runtime-events.helper';

/**
 * A routed call stamps attribution everywhere, and a stream that stops
 * says so.
 *
 * `docs/models.md` states the invariant: a routed call stamps `routing`
 * on the response, the node result and the audit log. It was false for
 * the commonest shape of all. The autonomous step processor spread
 * `llmResponse.routing` into the step it recorded when the model asked
 * for tool calls, and not into the step it recorded when the model just
 * answered — so a one-step reply persisted a cost with no model behind
 * it. The live `llm.response` event carried no routing either, although
 * it had it in scope, so a client watching a run could show the cost
 * accruing but never what it was accruing on. Multi-model routing that
 * nobody can see is the differentiator thrown away at the last step.
 *
 * Separately, `subscribeRunEvents` ended at its time ceiling with no
 * event at all. A run can outlive the ceiling — the stream stopped, the
 * run did not — so every client was left unable to tell "finished" from
 * "we stopped watching", and the CLI reported `running` from a
 * connection that had already closed.
 */
describe('routing attribution reaches every record of a step', () => {
  const source = readFileSync(join(__dirname, '..', 'agent-step-processor.ts'), 'utf8');

  it('stamps routing on the live llm.response event', () => {
    const at = source.indexOf("emitEvent(runId, 'llm.response'");
    expect(at).toBeGreaterThan(-1);
    // The payload object is short; the spread belongs inside it.
    expect(source.slice(at, at + 900)).toContain('llmResponse.routing');
  });

  it('stamps routing on every llm_call step the processor records', () => {
    // Both branches: the one that got tool calls and the one that got an
    // answer. Either missing is a cost with no model behind it.
    const steps = [...source.matchAll(/type:\s*'llm_call',[\s\S]{0,700}?timestamp:/g)];
    expect(steps.length).toBeGreaterThanOrEqual(1);
    const unstamped = steps.filter((m) => !m[0].includes('routing'));
    expect(unstamped.map((m) => m[0].slice(0, 120))).toEqual([]);
  });
});

describe('a run event stream that stops watching says so', () => {
  /** A redis double whose xread never returns anything, so the ceiling is what ends it. */
  const silentRedis = () => {
    const subscriber = { xread: jest.fn().mockResolvedValue(null), disconnect: jest.fn() };
    return { redis: { duplicate: () => subscriber } as any, subscriber };
  };

  const build = (redis: any) =>
        new AgentRuntimeEventsHelper({ findOne: jest.fn() } as any, redis);

  it('delivers stream.timeout when the ceiling ends the subscription', async () => {
    const { redis, subscriber } = silentRedis();
    const events: any[] = [];

    await build(redis).subscribeRunEvents('run-1', (e) => events.push(e), undefined, 30);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('stream.timeout');
    expect(events[0].data).toMatchObject({ runId: 'run-1', afterMs: 30 });
    expect(events[0].data.message).toMatch(/still going server-side/);
    expect(subscriber.disconnect).toHaveBeenCalled();
  });

  it('says nothing extra when the caller aborted — they know', async () => {
    const { redis } = silentRedis();
    const events: any[] = [];
    const controller = new AbortController();
    controller.abort();

    await build(redis).subscribeRunEvents('run-1', (e) => events.push(e), controller.signal, 30);

    expect(events).toEqual([]);
  });

  it('says nothing extra when a terminal event already arrived', async () => {
    const terminal = JSON.stringify({
      type: 'run.completed',
      data: { runId: 'run-1' },
      timestamp: new Date().toISOString(),
    });
    const subscriber = {
      xread: jest.fn().mockResolvedValue([['run:run-1:events', [['1-1', ['event', terminal]]]]]),
      disconnect: jest.fn(),
    };
    const events: any[] = [];

    await build({ duplicate: () => subscriber } as any).subscribeRunEvents(
      'run-1',
      (e) => events.push(e),
      undefined,
      5_000,
    );

    expect(events.map((e) => e.type)).toEqual(['run.completed']);
  });
});
