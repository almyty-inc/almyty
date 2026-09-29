import { AgentExecutionStatus } from '../../../entities/agent-execution.entity';
import type { AgentPipeline } from '../../../entities/agent.entity';
import { userPrincipal } from '../../../common/authorization/execution-access.service';
import { snapshotEnv } from '../../../test/env';
import { AgentValidationHelper } from '../agent-validation.helper';
import { getAgentTemplates } from '../agent-templates';
import { STEP_PAYLOAD_CAP } from '../persist-cap';
import { EXTRACT_CONTEXT_INSTRUCTION } from '../strategies/extract-context';
import { compileStrategy } from '../strategies/strategy-compiler';
import { STRATEGY_SEEDS } from '../strategies/strategy-seeds';
import {
  abortableDelay,
  buildHarness,
  edge,
  llm,
  LlmHandler,
  makeAgent,
  node,
  ORG,
  promptOf,
} from './workflow-harness';

/**
 * What a person drawing a workflow relies on, run through the real engine,
 * the real node executor and the real template resolver. Only the model, the
 * tools and the database are fakes (see workflow-harness.ts), so a green test
 * here means the behaviour holds end to end, not that a mock was called.
 *
 * Every pipeline below is also checked against the save-time validator, so
 * none of them is a graph the product would have refused to store.
 */
const validator = new AgentValidationHelper();
const savable = (pipeline: AgentPipeline, agentId?: string) => {
  validator.validatePipeline(pipeline, agentId);
  return pipeline;
};

const nodeResults = (execution: { nodeResults?: any }) => (execution.nodeResults ?? {}) as Record<string, any>;
const startedId = (events: Array<{ type: string; data?: any }>) =>
  events.find((e) => e.type === 'execution.started')?.data?.executionId as string;

/** Poll until `predicate` holds; a bounded wait that does not depend on CI speed. */
async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('workflow engine: branching', () => {
  const pipeline = () =>
    savable({
      nodes: [
        node('in', 'input'),
        node('cond', 'condition', { expression: '{{input.score}} > 5' }),
        llm('yes_1', 'HIGH {{input.topic}}'),
        llm('yes_2', 'REFINE {{nodes.yes_1.output}}'),
        llm('no_1', 'LOW {{input.topic}}'),
        node('merge', 'merge', { strategy: 'first_response' }),
        node('out', 'output', { source: 'nodes.merge.output' }),
      ],
      edges: [
        edge('in', 'cond'),
        edge('cond', 'yes_1', 'true'),
        edge('yes_1', 'yes_2'),
        edge('cond', 'no_1', 'false'),
        edge('yes_2', 'merge'),
        edge('no_1', 'merge'),
        edge('merge', 'out'),
      ],
    });

  it('runs only the true branch, skips every node on the false one, and the merge does not wait for it', async () => {
    const h = buildHarness();
    const execution = await h.run(makeAgent(pipeline()), { score: 9, topic: 'owls' });

    expect(execution.status).toBe(AgentExecutionStatus.COMPLETED);
    expect(h.promptsSent()).toEqual(['HIGH owls', 'REFINE echo: HIGH owls']);
    expect(nodeResults(execution).no_1).toEqual({ skipped: true });
    expect(execution.output).toBe('echo: REFINE echo: HIGH owls');
  });

  it('runs only the false branch, skipping the whole untaken chain', async () => {
    const h = buildHarness();
    const execution = await h.run(makeAgent(pipeline()), { score: 2, topic: 'owls' });

    expect(execution.status).toBe(AgentExecutionStatus.COMPLETED);
    expect(h.promptsSent()).toEqual(['LOW owls']);
    expect(nodeResults(execution).yes_1).toEqual({ skipped: true });
    expect(nodeResults(execution).yes_2).toEqual({ skipped: true });
    expect(execution.output).toBe('echo: LOW owls');
    expect(h.events.filter((e) => e.type === 'node.skipped').map((e) => e.nodeId).sort()).toEqual(['yes_1', 'yes_2']);
  });

  it('a condition it cannot evaluate fails the run and runs neither branch', async () => {
    const p = pipeline();
    p.nodes[1] = node('cond', 'condition', { expression: '{{input.topic}}.matches(owl)' });
    const h = buildHarness();
    const execution = await h.run(makeAgent(p), { score: 9, topic: 'owls' });

    expect(execution.status).toBe(AgentExecutionStatus.FAILED);
    expect(execution.error).toMatch(/cond: Condition node 'cond' uses an expression this engine cannot evaluate/);
    expect(h.chat).not.toHaveBeenCalled();
  });
});

describe('workflow engine: loop', () => {
  const pipeline = (loopData: Record<string, any>) =>
    savable({
      nodes: [
        node('in', 'input'),
        node('loop', 'loop', loopData),
        llm('each', 'Items: {{nodes.loop.output}}'),
        node('out', 'output', { source: 'nodes.loop.output' }),
      ],
      edges: [edge('in', 'loop'), edge('loop', 'each'), edge('each', 'out')],
    });

  it('carries every item of the array, in order, to what reads it', async () => {
    const h = buildHarness();
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const execution = await h.run(makeAgent(pipeline({ iterableExpression: '{{input.items}}' })), { items });

    expect(execution.status).toBe(AgentExecutionStatus.COMPLETED);
    expect(execution.output).toEqual(items);
    expect(h.promptsSent()).toEqual([`Items: ${JSON.stringify(items)}`]);
  });

  it('keeps at most maxIterations items', async () => {
    const h = buildHarness();
    const execution = await h.run(
      makeAgent(pipeline({ iterableExpression: '{{input.items}}', maxIterations: 2 })),
      { items: ['a', 'b', 'c', 'd'] },
    );
    expect(execution.output).toEqual(['a', 'b']);
  });

  it('is clamped by the run step ceiling even when the node asks for more', async () => {
    const h = buildHarness();
    const agent = makeAgent(pipeline({ iterableExpression: '{{input.items}}', maxIterations: 50 }), {
      agentConfig: { runLimits: { maxSteps: 3 } } as any,
    });
    const execution = await h.run(agent, { items: [1, 2, 3, 4, 5, 6] });
    expect(execution.output).toEqual([1, 2, 3]);
  });

  it('an empty array is an empty list, and the run still completes', async () => {
    const h = buildHarness();
    const execution = await h.run(makeAgent(pipeline({ iterableExpression: '{{input.items}}' })), { items: [] });

    expect(execution.status).toBe(AgentExecutionStatus.COMPLETED);
    expect(execution.output).toEqual([]);
    expect(h.promptsSent()).toEqual(['Items: []']);
  });

  it('an iterable that resolves to nothing fails the node by name instead of looping over [undefined]', async () => {
    const h = buildHarness();
    const execution = await h.run(makeAgent(pipeline({ iterableExpression: '{{input.itemz}}' })), { items: [1] });

    expect(execution.status).toBe(AgentExecutionStatus.FAILED);
    expect(nodeResults(execution).loop.error).toMatch(/Loop node 'loop'.*input\.itemz.*resolved to nothing/);
    expect(h.chat).not.toHaveBeenCalled();
  });

  it('an iterable it cannot parse stops the run cleanly, not left running', async () => {
    const h = buildHarness();
    const execution = await h.run(makeAgent(pipeline({ iterableExpression: '{{input.items[0]}}' })), { items: [1] });

    expect(execution.status).toBe(AgentExecutionStatus.FAILED);
    expect(h.execRepo.current(execution.id)?.status).toBe(AgentExecutionStatus.FAILED);
    expect(nodeResults(execution).loop.error).toMatch(/invalid characters/);
  });
});

describe('workflow engine: parallel and merge', () => {
  const DELAY = 400;
  const pipeline = (strategy = 'concatenate') =>
    savable({
      nodes: [
        node('in', 'input'),
        node('fan', 'parallel'),
        llm('a', 'A'),
        llm('b', 'B'),
        llm('c', 'C'),
        node('merge', 'merge', { strategy }),
        node('out', 'output', { source: 'nodes.merge.output' }),
      ],
      edges: [
        edge('in', 'fan'),
        edge('fan', 'a'),
        edge('fan', 'b'),
        edge('fan', 'c'),
        edge('a', 'merge'),
        edge('b', 'merge'),
        edge('c', 'merge'),
        edge('merge', 'out'),
      ],
    });

  it('runs the branches at the same time', async () => {
    let inFlight = 0;
    let peak = 0;
    const h = buildHarness({
      llm: async (req) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await abortableDelay(DELAY);
        inFlight--;
        return `done ${promptOf(req)}`;
      },
    });

    const started = Date.now();
    const execution = await h.run(makeAgent(pipeline()));
    const elapsed = Date.now() - started;

    expect(execution.status).toBe(AgentExecutionStatus.COMPLETED);
    // All three were in flight together: the proof that does not depend on
    // how fast the machine is.
    expect(peak).toBe(3);
    // And the wall clock agrees, with room for a slow CI box: one after the
    // other would be at least 3 x DELAY.
    expect(elapsed).toBeLessThan(3 * DELAY);
  });

  it('merges in edge order, not in the order the branches finished', async () => {
    const finishFirst: Record<string, number> = { A: 150, B: 60, C: 0 };
    const h = buildHarness({
      llm: async (req) => {
        await abortableDelay(finishFirst[promptOf(req)]);
        return `answer ${promptOf(req)}`;
      },
    });
    const execution = await h.run(makeAgent(pipeline()));

    expect(execution.output).toEqual(['answer A', 'answer B', 'answer C']);
  });

  it('a failed branch is left out of the merge, recorded as failed, and the run still answers', async () => {
    const h = buildHarness({
      llm: (req) => {
        if (promptOf(req) === 'B') throw new Error('provider is down');
        return `answer ${promptOf(req)}`;
      },
    });
    const execution = await h.run(makeAgent(pipeline()));

    expect(execution.status).toBe(AgentExecutionStatus.COMPLETED);
    expect(execution.output).toEqual(['answer A', 'answer C']);
    expect(nodeResults(execution).b.error).toMatch(/LLM call failed: provider is down/);
  });

  it('when every branch failed, the merge fails and so does the run', async () => {
    const h = buildHarness({
      llm: () => {
        throw new Error('provider is down');
      },
    });
    const execution = await h.run(makeAgent(pipeline()));

    expect(execution.status).toBe(AgentExecutionStatus.FAILED);
    expect(nodeResults(execution).merge.error).toMatch(/no upstream output/);
  });
});

describe('workflow engine: errors', () => {
  const pipeline = () =>
    savable({
      nodes: [
        node('in', 'input'),
        node('tool', 'tool_call', { toolId: 'tool-1', parameterMapping: { q: '{{input.q}}' } }),
        llm('summarise', 'Summarise {{nodes.tool.output}}'),
        node('out', 'output', { source: 'nodes.summarise.output' }),
      ],
      edges: [edge('in', 'tool'), edge('tool', 'summarise'), edge('summarise', 'out')],
    });

  it('a failing tool fails the run with a message naming the node, and nothing downstream runs', async () => {
    const h = buildHarness({ tool: () => ({ success: false, error: 'upstream answered 503' }) });
    const execution = await h.run(makeAgent(pipeline()), { q: 'x' });

    expect(execution.status).toBe(AgentExecutionStatus.FAILED);
    expect(execution.error).toBe('Pipeline failed: tool: upstream answered 503');
    expect(nodeResults(execution).tool.error).toBe('upstream answered 503');
    expect(nodeResults(execution).tool.input).toEqual({ toolId: 'tool-1', parameters: { q: 'x' } });
    expect(nodeResults(execution).summarise).toEqual({ skipped: true });
    expect(h.chat).not.toHaveBeenCalled();
    // Terminal in the table, and announced.
    expect(h.execRepo.current(execution.id)?.status).toBe(AgentExecutionStatus.FAILED);
    expect(h.events.map((e) => e.type)).toContain('execution.failed');
  });

  it('a failing model call fails the run and marks that node, not its neighbours', async () => {
    const h = buildHarness({
      llm: () => {
        throw new Error('context length exceeded');
      },
    });
    const execution = await h.run(makeAgent(pipeline()), { q: 'x' });

    expect(execution.status).toBe(AgentExecutionStatus.FAILED);
    expect(nodeResults(execution).summarise.error).toBe('LLM call failed: context length exceeded');
    expect(nodeResults(execution).tool.error).toBeUndefined();
    expect(nodeResults(execution).tool.output).toEqual({ toolId: 'tool-1', params: { q: 'x' } });
  });

  it('hands the run tool-error retry setting to the tool executor', async () => {
    const h = buildHarness();
    const agent = makeAgent(pipeline(), { agentConfig: { runLimits: { toolErrorRetries: 0 } } as any });
    await h.run(agent, { q: 'x' });

    expect(h.executeTool).toHaveBeenCalledTimes(1);
    expect(h.executeTool.mock.calls[0][2]).toMatchObject({ retries: 0 });
  });
});

describe('workflow engine: cancellation and limits', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = snapshotEnv('RUN_LIMIT_MAX_DURATION_MS', 'RUN_LIMIT_MAX_COST_CENTS');
  });
  afterEach(() => restore());

  const slowChain = () =>
    savable({
      nodes: [
        node('in', 'input'),
        llm('slow', 'SLOW'),
        llm('after', 'AFTER {{nodes.slow.output}}'),
        node('out', 'output', { source: 'nodes.after.output' }),
      ],
      edges: [edge('in', 'slow'), edge('slow', 'after'), edge('after', 'out')],
    });

  /** A model that takes 10s unless the signal it was handed aborts. */
  const hangingModel = (): { handler: LlmHandler; signals: AbortSignal[] } => {
    const signals: AbortSignal[] = [];
    return {
      signals,
      handler: async (req) => {
        if (req.signal) signals.push(req.signal);
        await abortableDelay(10_000, req.signal);
        return 'too late';
      },
    };
  };

  it('cancelling a run aborts the in-flight model call and runs nothing after it', async () => {
    const model = hangingModel();
    const h = buildHarness({ llm: model.handler });
    const running = h.run(makeAgent(slowChain()));

    await until(() => h.chat.mock.calls.length === 1);
    const started = Date.now();
    await h.cancellations.cancel(startedId(h.events), ORG);
    const execution = await running;

    expect(execution.status).toBe(AgentExecutionStatus.CANCELLED);
    expect(execution.error).toBe('Execution cancelled');
    expect(model.signals[0].aborted).toBe(true);
    expect(h.promptsSent()).toEqual(['SLOW']);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(h.execRepo.current(execution.id)?.status).toBe(AgentExecutionStatus.CANCELLED);
  });

  it('a run past its timeout stops with TIMEOUT, and the call in flight is aborted', async () => {
    const model = hangingModel();
    const h = buildHarness({ llm: model.handler });
    const execution = await h.run(makeAgent(slowChain(), { settings: { maxExecutionTime: 150 } as any }));

    expect(execution.status).toBe(AgentExecutionStatus.TIMEOUT);
    expect(execution.error).toMatch(/^Execution timed out after 150ms/);
    expect(model.signals[0].aborted).toBe(true);
    expect(h.promptsSent()).toEqual(['SLOW']);
  });

  it('the operator duration ceiling binds a workflow run, whatever the agent asks for', async () => {
    process.env.RUN_LIMIT_MAX_DURATION_MS = '150';
    const model = hangingModel();
    const h = buildHarness({ llm: model.handler });
    const execution = await h.run(makeAgent(slowChain(), { settings: { maxExecutionTime: 60_000 } as any }));

    expect(execution.status).toBe(AgentExecutionStatus.TIMEOUT);
    expect(execution.error).toMatch(/^Execution timed out after 150ms/);
  });

  it('the run cost cap stops a workflow run before the next step spends more', async () => {
    const h = buildHarness({ llm: (req) => ({ content: `paid ${promptOf(req)}`, cost: 0.05 }) });
    const agent = makeAgent(slowChain(), { agentConfig: { runLimits: { maxCostCents: 3 } } as any });
    const execution = await h.run(agent);

    expect(execution.status).toBe(AgentExecutionStatus.FAILED);
    expect(execution.error).toMatch(/Budget limit \(\$0\.03\) exceeded: \$0\.0500/);
    expect(h.promptsSent()).toEqual(['SLOW']);
  });

  it('the organization cost cap binds a workflow run too', async () => {
    const h = buildHarness({
      llm: (req) => ({ content: `paid ${promptOf(req)}`, cost: 0.05 }),
      organization: { id: ORG, agentDefaults: { maxCostPerRun: 0.02 } } as any,
    });
    const execution = await h.run(makeAgent(slowChain()));

    expect(execution.status).toBe(AgentExecutionStatus.FAILED);
    expect(execution.error).toMatch(/Budget limit \(\$0\.02\) exceeded/);
  });

  it('an agent budgetLimit tighter than the run cap still applies', async () => {
    const h = buildHarness({ llm: (req) => ({ content: `paid ${promptOf(req)}`, cost: 0.05 }) });
    const execution = await h.run(makeAgent(slowChain(), { settings: { budgetLimit: 0.01 } as any }));

    expect(execution.status).toBe(AgentExecutionStatus.FAILED);
    expect(execution.error).toMatch(/Budget limit \(\$0\.01\) exceeded/);
  });

  it('the tool-call ceiling stops the run with its reason', async () => {
    const h = buildHarness();
    const p = savable({
      nodes: [
        node('in', 'input'),
        node('t1', 'tool_call', { toolId: 'tool-1' }),
        node('t2', 'tool_call', { toolId: 'tool-2' }),
        node('out', 'output', { source: 'nodes.t2.output' }),
      ],
      edges: [edge('in', 't1'), edge('t1', 't2'), edge('t2', 'out')],
    });
    const execution = await h.run(makeAgent(p, { agentConfig: { runLimits: { maxToolCalls: 1 } } as any }));

    expect(execution.status).toBe(AgentExecutionStatus.FAILED);
    expect(nodeResults(execution).t2.error).toMatch(/^TOOL_CALL_LIMIT_EXCEEDED: The run reached its maximum number of tool calls/);
    expect(h.executeTool).toHaveBeenCalledTimes(1);
  });
});

describe('workflow engine: data flow', () => {
  const pipeline = (prompt: string) =>
    savable({
      nodes: [
        node('in', 'input'),
        llm('a', 'first'),
        llm('b', 'second'),
        llm('c', prompt),
        node('out', 'output', { source: 'nodes.c.output' }),
      ],
      edges: [edge('in', 'a'), edge('in', 'b'), edge('a', 'c'), edge('b', 'c'), edge('c', 'out')],
    });

  it('resolves each reference from the node it names', async () => {
    const h = buildHarness();
    const agent = makeAgent(pipeline('{{nodes.b.output}} | {{nodes.a.output}} | {{input.q}} | {{variables.tone}}'), {
      variables: { tone: 'dry' },
    });
    const execution = await h.run(agent, { q: 'why' });

    expect(execution.status).toBe(AgentExecutionStatus.COMPLETED);
    expect(execution.output).toBe('echo: echo: second | echo: first | why | dry');
  });

  it('records a reference that resolved to nothing on the node that made it', async () => {
    const h = buildHarness();
    const execution = await h.run(makeAgent(pipeline('Use {{nodes.nope.output}} and {{nodes.a.output}}')));

    expect(nodeResults(execution).c.unresolvedReferences).toEqual(['nodes.nope.output']);
  });

  it('a prompt that resolves to nothing fails naming the reference, not claiming the prompt is unset', async () => {
    const h = buildHarness();
    const execution = await h.run(makeAgent(pipeline('{{input.question}}')), { message: 'hi' });

    expect(execution.status).toBe(AgentExecutionStatus.FAILED);
    expect(nodeResults(execution).c.error).toMatch(/LLM call node 'c'.*resolved to an empty prompt.*input\.question/);
  });

  it('a large output reaches the next step whole, and is capped on the run record', async () => {
    const huge = 'x'.repeat(200_000);
    const h = buildHarness({ tool: () => ({ success: true, data: huge }) });
    const p = savable({
      nodes: [
        node('in', 'input'),
        node('tool', 'tool_call', { toolId: 'tool-1' }),
        llm('read', '{{nodes.tool.output}}'),
        node('out', 'output', { mapping: { length: 'done' } }),
      ],
      edges: [edge('in', 'tool'), edge('tool', 'read'), edge('read', 'out')],
    });
    const execution = await h.run(makeAgent(p));

    expect(execution.status).toBe(AgentExecutionStatus.COMPLETED);
    // Downstream got all of it...
    expect(promptOf(h.chat.mock.calls[0][1])).toHaveLength(200_000);
    // ...while the persisted record did not keep two copies of 200KB.
    const persisted = nodeResults(execution);
    for (const id of ['tool', 'read']) {
      expect(typeof persisted[id].output).toBe('string');
      expect(persisted[id].output.length).toBeLessThan(STEP_PAYLOAD_CAP + 100);
      expect(persisted[id].output).toMatch(/truncated from 200\d{3} characters/);
    }
  });
});

describe('workflow engine: sub_agent', () => {
  const child = () =>
    makeAgent(
      savable({
        nodes: [node('in', 'input'), llm('write', 'CHILD {{input.topic}}'), node('out', 'output', { source: 'nodes.write.output' })],
        edges: [edge('in', 'write'), edge('write', 'out')],
      }),
      { id: 'child-1', name: 'Child' },
    );

  const parent = (childId = 'child-1') =>
    makeAgent(
      savable(
        {
          nodes: [
            node('in', 'input'),
            node('sub', 'sub_agent', { agentId: childId, inputMapping: [{ key: 'topic', value: '{{input.subject}}' }] }),
            llm('wrap', 'PARENT {{nodes.sub.output}}'),
            node('out', 'output', { source: 'nodes.wrap.output' }),
          ],
          edges: [edge('in', 'sub'), edge('sub', 'wrap'), edge('wrap', 'out')],
        },
        'parent-1',
      ),
      { id: 'parent-1', name: 'Parent' },
    );

  it('passes the mapped input down and the child answer up, with its cost', async () => {
    const h = buildHarness({ llm: (req) => ({ content: `echo: ${promptOf(req)}`, cost: 0.01 }) });
    h.agents.set('child-1', child());
    const execution = await h.run(parent(), { subject: 'rust' });

    expect(execution.status).toBe(AgentExecutionStatus.COMPLETED);
    expect(nodeResults(execution).sub.output).toBe('echo: CHILD rust');
    expect(execution.output).toBe('echo: PARENT echo: CHILD rust');
    expect(execution.totalCost).toBeCloseTo(0.02);
  });

  it('runs the child as the run principal, the one the parent was started with', async () => {
    const h = buildHarness();
    h.agents.set('child-1', child());
    const principal = userPrincipal('user-1', 'api_key');
    await h.run(parent(), { subject: 'rust' }, { principal });

    const checked = h.assertCanExecute.mock.calls.map(([p, resource]) => [p, (resource as any).id]);
    expect(checked).toEqual([
      [principal, 'parent-1'],
      [principal, 'child-1'],
    ]);
  });

  it('a sub-agent that calls itself stops at the recursion ceiling instead of recursing forever', async () => {
    const h = buildHarness();
    // Saved around the validator's direct self-reference check, the way a
    // two-agent cycle (A -> B -> A) would get past it.
    const selfCalling = makeAgent(
      {
        nodes: [node('in', 'input'), node('sub', 'sub_agent', { agentId: 'loop-1' }), node('out', 'output')],
        edges: [edge('in', 'sub'), edge('sub', 'out')],
      },
      { id: 'loop-1' },
    );
    const execution = await h.run(selfCalling, { topic: 'x' });

    expect(execution.status).toBe(AgentExecutionStatus.FAILED);
    expect(execution.error).toMatch(/Max nesting depth \(3\) exceeded/);
    // The top-level run plus three nested ones, then the refusal.
    expect(h.execRepo.create).toHaveBeenCalledTimes(4);
  });

  it('a child that timed out fails the node rather than handing back null as its answer', async () => {
    const h = buildHarness({
      llm: async (req) => {
        if (promptOf(req).startsWith('CHILD')) await abortableDelay(10_000, req.signal);
        return `echo: ${promptOf(req)}`;
      },
    });
    const slowChild = child();
    slowChild.settings = { maxExecutionTime: 100 } as any;
    h.agents.set('child-1', slowChild);
    const execution = await h.run(parent(), { subject: 'rust' });

    expect(execution.status).toBe(AgentExecutionStatus.FAILED);
    expect(nodeResults(execution).sub.error).toMatch(/Sub-agent execution timeout: Execution timed out after 100ms/);
    expect(nodeResults(execution).wrap).toEqual({ skipped: true });
  });
});

describe('workflow engine: verify and extract_context', () => {
  const verdict = (pass: boolean) =>
    JSON.stringify(
      pass
        ? { verdict: 'pass', failures: [], passed_rules: ['cites a source'] }
        : { verdict: 'fail', failures: [{ rule: 'cites a source', evidence: 'no citation' }], passed_rules: [] },
    );

  const checked = (checkerVerdicts: boolean[]): LlmHandler => {
    let checker = 0;
    return (req) => {
      const system = String(req.messages[0]?.content ?? '');
      if (system.startsWith('You are a verifier')) return verdict(checkerVerdicts[checker++ % checkerVerdicts.length]);
      return `echo: ${promptOf(req)}`;
    };
  };

  const gated = () =>
    savable({
      nodes: [
        node('in', 'input'),
        llm('draft', 'DRAFT {{input.message}}'),
        node('check', 'verify', {
          spec: 'must cite a source',
          checkers: [
            { name: 'strict', providerId: 'p-v' },
            { name: 'lenient', providerId: 'p-v' },
          ],
        }),
        node('gate', 'condition', { expression: '{{nodes.check.output.verdict}} == pass' }),
        node('ok', 'output', { source: 'nodes.draft.output' }),
        llm('fix', 'FIX {{nodes.draft.output}} {{nodes.check.output.failures}}'),
        node('fixed', 'output', { source: 'nodes.fix.output' }),
      ],
      edges: [
        edge('in', 'draft'),
        edge('draft', 'check'),
        edge('check', 'gate'),
        edge('gate', 'ok', 'true'),
        edge('gate', 'fix', 'false'),
        edge('fix', 'fixed'),
      ],
    });

  it('produces a verdict a condition can branch on: pass goes straight to the answer', async () => {
    const h = buildHarness({ llm: checked([true, true]) });
    const execution = await h.run(makeAgent(gated()), { message: 'hi' });

    expect(execution.status).toBe(AgentExecutionStatus.COMPLETED);
    expect(nodeResults(execution).check.output).toMatchObject({
      verdict: 'pass',
      passed: true,
      policy: 'any_fail_blocks',
      failures: [],
      passed_rules: ['cites a source'],
    });
    expect(nodeResults(execution).check.output.checkers.map((c: any) => c.checker)).toEqual(['strict', 'lenient']);
    expect(execution.output).toBe('echo: DRAFT hi');
    expect(nodeResults(execution).fix).toEqual({ skipped: true });
  });

  it('a failing checker takes the false branch, and the fix sees what failed', async () => {
    const h = buildHarness({ llm: checked([true, false]) });
    const execution = await h.run(makeAgent(gated()), { message: 'hi' });

    expect(execution.status).toBe(AgentExecutionStatus.COMPLETED);
    expect(nodeResults(execution).check.output.verdict).toBe('fail');
    expect(nodeResults(execution).ok).toEqual({ skipped: true });
    expect(execution.output).toMatch(/^echo: FIX echo: DRAFT hi .*no citation/);
  });

  const exploring = () =>
    savable({
      nodes: [
        node('in', 'input'),
        llm('try1', 'EXPLORE one'),
        llm('try2', 'EXPLORE two'),
        node('brief', 'extract_context', { providerId: 'p-1' }),
        node('out', 'output', { source: 'nodes.brief.output' }),
      ],
      edges: [edge('in', 'try1'), edge('in', 'try2'), edge('try1', 'brief'), edge('try2', 'brief'), edge('brief', 'out')],
    });

  it('extract_context compresses the upstream attempts into the documented brief', async () => {
    const brief = { relevantFiles: ['src/a.ts'], symbols: ['run'], callers: ['main'], tests: ['a.spec.ts'], notes: 'n' };
    const h = buildHarness({
      llm: (req) =>
        req.messages[0]?.content === EXTRACT_CONTEXT_INSTRUCTION
          ? '```json\n' + JSON.stringify(brief) + '\n```'
          : `found ${promptOf(req)}`,
    });
    const execution = await h.run(makeAgent(exploring()), { message: 'fix the bug' });

    expect(execution.status).toBe(AgentExecutionStatus.COMPLETED);
    expect(execution.output).toEqual(brief);
    const extractPrompt = promptOf(h.chat.mock.calls.find(([, r]) => r.messages[0]?.content === EXTRACT_CONTEXT_INSTRUCTION)![1]);
    expect(extractPrompt).toContain('found EXPLORE one');
    expect(extractPrompt).toContain('found EXPLORE two');
  });

  it('an unreadable brief fails the node rather than passing transcripts through', async () => {
    const h = buildHarness({ llm: (req) => (req.messages[0]?.content === EXTRACT_CONTEXT_INSTRUCTION ? 'no json' : 'x') });
    const execution = await h.run(makeAgent(exploring()), { message: 'fix the bug' });

    expect(execution.status).toBe(AgentExecutionStatus.FAILED);
    expect(nodeResults(execution).brief.error).toBeTruthy();
  });
});

describe('workflow engine: every built-in strategy runs to an answer', () => {
  const brief = { relevantFiles: [], symbols: [], callers: [], tests: [], notes: 'ok' };
  const strategyModel: LlmHandler = (req) => {
    const system = String(req.messages[0]?.content ?? '');
    if (system.startsWith('You are a verifier')) return JSON.stringify({ verdict: 'pass', failures: [], passed_rules: [] });
    if (system === EXTRACT_CONTEXT_INSTRUCTION) return JSON.stringify(brief);
    return `answer to: ${promptOf(req)}`;
  };

  for (const seed of STRATEGY_SEEDS) {
    it(`${seed.key}: the request reaches the model and the run completes`, async () => {
      const roles = seed.roleSlots ?? [];
      const pipeline = compileStrategy(seed, Object.fromEntries(roles.map((r) => [r, r])));
      savable(pipeline);
      const h = buildHarness({
        llm: strategyModel,
        strategy: { key: seed.key, pipeline, roles },
        // The panel's consensus judge has no role slot of its own, so it
        // takes the organization default routing policy (docs/strategies.md,
        // What a call is asked); without one it fails by name.
        organization: { id: ORG, settings: { defaultRouting: { objective: 'balanced' } } } as any,
      });
      const agent = makeAgent({ nodes: [], edges: [] }, { settings: { execution: { strategyKey: seed.key } } as any });

      const execution = await h.run(agent, { message: 'Write a haiku about owls' });

      expect(execution.error ?? null).toBeNull();
      expect(execution.status).toBe(AgentExecutionStatus.COMPLETED);
      // Every model call that is not a checker was asked the question.
      const asked = h.chat.mock.calls
        .map(([, req]) => req)
        .filter((req) => !String(req.messages[0]?.content ?? '').startsWith('You are a verifier'));
      expect(asked.length).toBeGreaterThan(0);
      for (const req of asked) {
        expect(JSON.stringify(req.messages)).toContain('Write a haiku about owls');
      }
    });
  }
});

describe('save-time graph validation', () => {
  const base = (): AgentPipeline => ({
    nodes: [node('in', 'input'), llm('ask', '{{input.message}}'), node('out', 'output')],
    edges: [edge('in', 'ask'), edge('ask', 'out')],
  });
  const refusal = (pipeline: AgentPipeline): string => {
    try {
      validator.validatePipeline(pipeline);
    } catch (err: any) {
      return err.message;
    }
    return 'accepted';
  };

  it('accepts the plain graph these cases change', () => {
    expect(refusal(base())).toBe('accepted');
  });

  it('refuses a cycle, naming the nodes in it', () => {
    const p = base();
    p.nodes.push(llm('back', 'again'));
    p.edges.push(edge('ask', 'back'), edge('back', 'ask'));
    expect(refusal(p)).toMatch(/^Pipeline contains a cycle through node\(s\) 'ask', 'back'/);
  });

  it('refuses a node nothing connects to', () => {
    const p = base();
    p.nodes.push(llm('stray', 'hello'));
    expect(refusal(p)).toMatch(/^Node\(s\) 'stray' are not reachable from the input node 'in'/);
  });

  const missing: Array<[string, (p: AgentPipeline) => void, RegExp]> = [
    [
      'a model call with no prompt',
      (p) => (p.nodes[1] = node('ask', 'llm_call', { providerId: 'p-1' })),
      /^LLM call node 'ask' must have a 'userPromptTemplate'/,
    ],
    [
      'a condition with no expression',
      (p) => {
        p.nodes.push(node('cond', 'condition'), node('alt', 'output'));
        p.edges.splice(1, 1, edge('ask', 'cond'), edge('cond', 'out', 'true'), edge('cond', 'alt', 'false'));
      },
      /^Condition node 'cond' must have an 'expression'/,
    ],
    [
      'a transform with no expression',
      (p) => {
        p.nodes.push(node('shape', 'transform'));
        p.edges.splice(1, 1, edge('ask', 'shape'), edge('shape', 'out'));
      },
      /^Transform node 'shape' must have an 'expression'/,
    ],
    [
      'a loop with no iterable',
      (p) => {
        p.nodes.push(node('each', 'loop', { maxIterations: 3 }));
        p.edges.splice(1, 1, edge('ask', 'each'), edge('each', 'out'));
      },
      /^Loop node 'each' must have an 'iterableExpression'/,
    ],
    [
      'a tool call with no tool',
      (p) => {
        p.nodes.push(node('t', 'tool_call'));
        p.edges.splice(1, 1, edge('ask', 't'), edge('t', 'out'));
      },
      /^Tool call node 't' must have 'toolId' in config/,
    ],
  ];

  for (const [what, change, message] of missing) {
    it(`refuses ${what}, saying what to set`, () => {
      const p = base();
      change(p);
      expect(refusal(p)).toMatch(message);
    });
  }

  it('still accepts every starter template and every built-in strategy, compiled', () => {
    for (const template of getAgentTemplates()) {
      expect([template.id, refusal(template.pipeline)]).toEqual([template.id, 'accepted']);
    }
    for (const seed of STRATEGY_SEEDS) {
      const pipeline = compileStrategy(seed, Object.fromEntries((seed.roleSlots ?? []).map((r) => [r, r])));
      expect([seed.key, refusal(pipeline)]).toEqual([seed.key, 'accepted']);
    }
  });
});
