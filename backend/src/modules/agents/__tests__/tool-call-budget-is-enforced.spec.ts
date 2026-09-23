import { readFileSync } from 'fs';
import { join } from 'path';

import { AgentNodeExecutor } from '../agent-node-executor';

/**
 * `maxToolCalls` was resolved on every run and enforced by nothing.
 *
 * Both halves of the product had the shape. In the workflow engine the
 * limit was written onto the execution context -- with a comment claiming
 * "the maxSteps/maxToolCalls clamp in agent-node-executor reads
 * context.runLimits" -- and the node executor only ever read `maxSteps`.
 * In the autonomous runtime `checkRunLimits` compared it against
 * `AgentRun.toolCallCount`, a column with a migration, an entity field, a
 * doc comment, and no code anywhere that incremented it: the comparison was
 * `0 >= maxToolCalls` on every step of every run, so
 * TOOL_CALL_LIMIT_EXCEEDED was unreachable.
 *
 * Both were covered by passing tests, because a limit that is never applied
 * is indistinguishable from a limit that is never exceeded. Hence the
 * source-reading guards below alongside the behavioural ones.
 */
const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

describe('the tool-call budget is enforced in the workflow engine', () => {
  const build = (calls: string[]) => {
    const executor = Object.create(AgentNodeExecutor.prototype) as AgentNodeExecutor;
    (executor as any).templateResolver = { resolve: (t: string) => t };
    (executor as any).toolExecutorService = {
      executeTool: async (toolId: string) => {
        calls.push(toolId);
        return { success: true, data: 'ok' };
      },
    };
    return executor;
  };

  const runTool = (executor: AgentNodeExecutor, context: any, id = 't') =>
    (executor as any).executeToolCallNode(
      { id, data: { toolId: `tool-${id}` } },
      context,
      { organizationId: 'org-1' },
    );

  it('spends the budget across every node of the run, not per node', async () => {
    const calls: string[] = [];
    const executor = build(calls);
    // One context object, shared by every node of the run, exactly as the
    // engine builds it.
    const context = {
      input: {},
      nodes: {},
      runLimits: { maxSteps: 50, maxToolCalls: 2 },
      toolCalls: { count: 0 },
    };

    await runTool(executor, context, 'a');
    await runTool(executor, context, 'b');
    await expect(runTool(executor, context, 'c')).rejects.toThrow(
      /TOOL_CALL_LIMIT_EXCEEDED/,
    );

    // The third call must not have reached the tool executor. A clamp that
    // only reports after the spend is not a budget.
    expect(calls).toEqual(['tool-a', 'tool-b']);
  });

  it('counts the call before it is made, so the ceiling is calls actually made', async () => {
    const calls: string[] = [];
    const executor = build(calls);
    const context = {
      input: {},
      nodes: {},
      runLimits: { maxToolCalls: 1 },
      toolCalls: { count: 0 },
    };
    await runTool(executor, context, 'a');
    expect(context.toolCalls.count).toBe(1);
    await expect(runTool(executor, context, 'b')).rejects.toThrow(
      /TOOL_CALL_LIMIT_EXCEEDED/,
    );
    expect(calls).toHaveLength(1);
  });

  it('does not clamp when no ceiling reached the context', async () => {
    const calls: string[] = [];
    const executor = build(calls);
    const context: any = { input: {}, nodes: {}, toolCalls: { count: 0 } };
    await runTool(executor, context, 'a');
    await runTool(executor, context, 'b');
    expect(calls).toHaveLength(2);
  });

  it('carries the machine-readable reason code, not a bare stop', async () => {
    const executor = build([]);
    const context = {
      input: {},
      nodes: {},
      runLimits: { maxToolCalls: 0 },
      toolCalls: { count: 0 },
    };
    await expect(runTool(executor, context)).rejects.toMatchObject({
      code: 'TOOL_CALL_LIMIT_EXCEEDED',
    });
  });
});

describe('the workflow engine wires the ledger the clamp reads', () => {
  it('the engine puts a run-scoped tool-call counter on the context', () => {
    const src = read('agent-execution.engine.ts');
    const literal = src.match(/const context: ExecutionContext = \{[\s\S]*?\n {6}\};/);
    expect(literal).not.toBeNull();
    expect(literal![0]).toContain('toolCalls: { count: 0 }');
  });

  it('the node executor reads the ceiling AND increments the counter', () => {
    const src = read('agent-node-executor.ts');
    const body = src.slice(
      src.indexOf('private async executeToolCallNode('),
      src.indexOf('private async executeConditionNode('),
    );
    expect(body).toContain('context.runLimits?.maxToolCalls');
    expect(body).toContain('context.toolCalls.count++');
    // Before the call, not after it.
    expect(body.indexOf('context.toolCalls.count++')).toBeLessThan(
      body.indexOf('this.toolExecutorService.executeTool('),
    );
  });

  it('ExecutionContext declares the counter, so the two ends agree', () => {
    expect(read('agent-template-resolver.ts')).toMatch(/toolCalls\?: \{ count: number \}/);
  });
});

describe('the autonomous runtime keeps a real tool-call ledger', () => {
  const processor = read('agent-step-processor.ts');

  it('the per-tool-call check compares the ledger against the resolved ceiling', () => {
    const loop = processor.slice(
      processor.indexOf('for (const toolCall of responseMessage.toolCalls)'),
      processor.indexOf('const toolExecStart = Date.now();'),
    );
    expect(loop).toContain('run.toolCallCount');
    expect(loop).toContain('resolvedLimits.maxToolCalls');
    expect(loop).toContain("describeLimitTrip('TOOL_CALL_LIMIT_EXCEEDED')");
  });

  it('the ledger is incremented, which nothing did before', () => {
    expect(processor).toContain('run.toolCallCount = (run.toolCallCount ?? 0) + 1');
  });

  it('the check sits inside the tool loop, not only once per step', () => {
    // One step may carry any number of tool calls, so the check at the top
    // of processStep is no ceiling on its own.
    const loopAt = processor.indexOf('for (const toolCall of responseMessage.toolCalls)');
    const checkAt = processor.indexOf('>= resolvedLimits.maxToolCalls');
    expect(loopAt).toBeGreaterThan(-1);
    expect(checkAt).toBeGreaterThan(loopAt);
  });

  it('commitStep persists the ledger, so it survives the next step', () => {
    const commit = processor.slice(processor.indexOf('private async commitStep('));
    expect(commit).toContain('toolCallCount: run.toolCallCount ?? 0');
  });

  it('a new run starts the ledger at zero rather than leaving it undefined', () => {
    expect(read('agent-runtime.service.ts')).toContain('toolCallCount: 0');
  });
});
