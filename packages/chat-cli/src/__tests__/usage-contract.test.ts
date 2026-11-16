/**
 * The usage `chat --json` prints is the usage the backend recorded.
 *
 * Two halves. The first replays what staging actually sent for one
 * answer (fixtures/staging-usage.json, captured with the real CLI login)
 * through a turn and `--json`, and holds the printed tokens and cost to
 * the totals the backend persisted for that same run or execution. A
 * workflow answer used to print twice its tokens: the reducer added the
 * pipeline's totals on top of the node figures they are the sum of.
 *
 * The second reads the backend's and the client's SOURCE for the field
 * names the reducer depends on, so a rename on either side fails here, on
 * the commit that makes it, rather than as a silent 0 in the release gate.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AgentInfo, AgentRun, StreamEvent } from '@almyty/client';

import { jsonResult } from '../headless.js';
import { runTurn, type TurnTarget } from '../turn.js';

interface Recorded {
  autonomous: { events: StreamEvent[]; run: { status: string; totalTokens: number; totalCost: number } };
  workflow: { events: StreamEvent[]; execution: { status: string; totalTokens: number; totalCost: number } };
}

const recorded = JSON.parse(
  readFileSync(new URL('./fixtures/staging-usage.json', import.meta.url), 'utf-8'),
) as Recorded;

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf-8');

/** A gateway that replays recorded events and answers with the recorded run. */
function replay(events: StreamEvent[], run?: Partial<AgentRun>): TurnTarget {
  return {
    async startRun() {
      return { id: 'run_1', status: 'running' } as AgentRun;
    },
    async streamRun(runId, handler) {
      for (const event of events) handler(event);
      return { id: runId, ...run } as AgentRun;
    },
    async streamInvoke(_input, handler) {
      for (const event of events) handler(event);
    },
    async invoke() {
      return undefined;
    },
    async sendRunInput() {},
    async cancelRun() {},
    async cancelExecution() {},
  };
}

function agent(mode: 'autonomous' | 'workflow'): AgentInfo {
  return { id: 'a1', name: 'agent', slug: 'agent', mode } as AgentInfo;
}

describe('chat --json usage against what staging recorded', () => {
  it('an autonomous answer reports the run total, not only the calls the stream showed', async () => {
    const { events, run } = recorded.autonomous;
    const result = await runTurn(replay(events, run), 'q', { mode: 'autonomous' });
    const printed = jsonResult(result, agent('autonomous')) as { status: string; usage: { tokens: number; cost: number } };

    expect(printed.status).toBe('completed');
    expect(printed.usage.tokens).toBe(run.totalTokens);
    expect(printed.usage.cost).toBeCloseTo(run.totalCost, 9);
  });

  it('a workflow answer reports the execution total once', async () => {
    const { events, execution } = recorded.workflow;
    const result = await runTurn(replay(events), 'q', { mode: 'workflow' });
    const printed = jsonResult(result, agent('workflow')) as { status: string; usage: { tokens: number; cost: number } };

    expect(printed.status).toBe('completed');
    expect(printed.usage.tokens).toBe(execution.totalTokens);
    expect(printed.usage.cost).toBeCloseTo(execution.totalCost, 9);
  });
});

describe('the usage field names, on both sides', () => {
  const stepProcessor = source('../../../../backend/src/modules/agents/agent-step-processor.ts');
  const engine = source('../../../../backend/src/modules/agents/agent-execution.engine.ts');
  const runEntity = source('../../../../backend/src/entities/agent-run.entity.ts');
  const client = source('../../../client/src/client.ts');
  const reducer = source('../stream.ts');
  const turn = source('../turn.ts');

  /** The source of the emitEvent call that sends `type`, up to its closing `});`. */
  function emitted(src: string, type: string): string[] {
    const calls: string[] = [];
    const quoted = `'${type}'`;
    let at = src.indexOf(quoted);
    while (at !== -1) {
      const end = src.indexOf('});', at);
      calls.push(src.slice(at, end === -1 ? undefined : end));
      at = src.indexOf(quoted, at + quoted.length);
    }
    return calls;
  }

  it('an autonomous model call carries usage.inputTokens/outputTokens and cost, which the reducer reads', () => {
    const responses = emitted(stepProcessor, 'llm.response');
    expect(responses.some((c) => /usage:\s*\{\s*inputTokens:[^}]*outputTokens:/.test(c) && /\bcost:/.test(c))).toBe(true);
    expect(reducer).toMatch(/usage\.totalTokens\)\s*\|\|\s*num\(usage\.inputTokens\)\s*\+\s*num\(usage\.outputTokens\)/);
  });

  it('the persisted run carries totalTokens and totalCost, through the client, into the turn', () => {
    expect(runEntity).toMatch(/\btotalTokens: number;/);
    expect(runEntity).toMatch(/\btotalCost: number;/);
    expect(client).toMatch(/\btotalTokens\?: number;/);
    expect(turn).toMatch(/run\.totalTokens/);
    expect(turn).toMatch(/run\.totalCost/);
  });

  it('a workflow node carries tokens and cost, and the execution carries totalTokens and totalCost', () => {
    const nodes = emitted(engine, 'node.completed');
    expect(nodes.some((c) => /\btokens: result\.tokens/.test(c) && /\bcost: result\.cost/.test(c))).toBe(true);
    const done = emitted(engine, 'execution.completed');
    expect(done.some((c) => /\btotalTokens\b/.test(c) && /\btotalCost\b/.test(c))).toBe(true);
    expect(reducer).toMatch(/num\(d\.tokens\)/);
    expect(reducer).toMatch(/num\(d\.totalTokens\)/);
  });
});
