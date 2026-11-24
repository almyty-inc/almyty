import { AgentNodeExecutor, waitForMachine } from '../agent-node-executor';
import { MACHINE_FAILED, WORKSPACE_BUSY, WORKSPACE_WAKING } from '../../runner/hosted-dispatch';

/**
 * A workflow tool step whose hosted machine was still starting failed with
 * `workspace_waking` ("try again shortly") instead of waiting, while an
 * autonomous run sleeps and makes the same call again. The step now waits
 * the same way: the same call, one call against the run's budget, ended by
 * the wake budget (the dispatch fails the machine past it).
 */
const waking = (code = WORKSPACE_WAKING) => ({
  success: false,
  error: 'The machine is starting; try again shortly',
  metadata: { runnerErrorCode: code, retryAfterMs: 1, retryable: true },
});

describe('a workflow tool step waits for its hosted machine', () => {
  const build = (answers: any[], calls: any[]) => {
    const executor = Object.create(AgentNodeExecutor.prototype) as AgentNodeExecutor;
    (executor as any).templateResolver = { resolve: (t: string) => t };
    (executor as any).toolExecutorService = {
      executeTool: async (toolId: string, params: any, opts: any) => {
        calls.push({ toolId, params, environmentId: opts.environmentId });
        return answers.shift() ?? { success: true, data: 'ran' };
      },
    };
    return executor;
  };
  const runTool = (executor: AgentNodeExecutor, context: any) =>
    (executor as any).executeToolCallNode(
      { id: 'n', data: { toolId: 'tool-1', parameterMapping: { path: 'a.txt' } } },
      context,
      { organizationId: 'org-1', environmentId: 'env-1' },
    );

  it('makes the same call again once the machine is up, and spends one call of the budget', async () => {
    const calls: any[] = [];
    const executor = build([waking(), waking(WORKSPACE_BUSY), { success: true, data: 'hello' }], calls);
    const context = { input: {}, nodes: {}, runLimits: { maxToolCalls: 1 }, toolCalls: { count: 0 } };
    const result = await runTool(executor, context);
    expect(result.output).toBe('hello');
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.toolId === 'tool-1' && c.params.path === 'a.txt' && c.environmentId === 'env-1')).toBe(true);
    expect(context.toolCalls.count).toBe(1);
  });

  it('fails with the machine problem once the wake budget runs out', async () => {
    const calls: any[] = [];
    const failed = { success: false, error: 'The machine for this environment did not start within 180 seconds', metadata: { [MACHINE_FAILED]: true } };
    const executor = build([waking(), failed], calls);
    await expect(runTool(executor, { input: {}, nodes: {} })).rejects.toThrow(/did not start within 180 seconds/);
    expect(calls).toHaveLength(2);
  });

  it('stops waiting when the run is cancelled', async () => {
    const controller = new AbortController();
    let n = 0;
    const result = await waitForMachine(controller.signal, async () => {
      n++;
      controller.abort();
      return waking();
    });
    expect(n).toBe(1);
    expect(result.metadata.runnerErrorCode).toBe(WORKSPACE_WAKING);
  });

  it('stops at the ceiling', async () => {
    let n = 0;
    const result = await waitForMachine(undefined, async () => {
      n++;
      return waking();
    }, 0);
    expect(n).toBe(1);
    expect(result.success).toBe(false);
  });
});
