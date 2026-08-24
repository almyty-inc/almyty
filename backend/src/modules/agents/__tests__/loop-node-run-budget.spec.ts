import { AgentNodeExecutor } from '../agent-node-executor';

/**
 * The loop node's own guard and the run budget used to be two unrelated
 * mechanisms, so a loop could iterate far past the ceiling that governed
 * every other part of the same run.
 */
describe('loop node respects the run budget', () => {
  // Only the template resolver participates in a loop node; the rest of
  // the executor's dependencies are irrelevant here.
  const executor = Object.create(AgentNodeExecutor.prototype) as AgentNodeExecutor;
  (executor as any).templateResolver = {
    resolveValue: (path: string, ctx: any) => ctx.input[path.replace('input.', '')],
    resolve: (expression: string) => expression,
  };

  const runLoop = async (maxIterations: number | undefined, runLimits?: any) =>
    (executor as any).executeLoopNode(
      { id: 'loop-1', data: { iterableExpression: '{{input.items}}', maxIterations } },
      { input: { items: Array.from({ length: 100 }, (_, i) => i) }, nodes: {}, runLimits },
    );

  it('honours the node setting when there is no run ceiling', async () => {
    const result = await runLoop(10)
    expect(result.output).toHaveLength(10);
  });

  it('clamps the node to the run ceiling', async () => {
    const result = await runLoop(100, { maxSteps: 25 });
    expect(result.output).toHaveLength(25);
  });

  it('lets the node tighten below the run ceiling', async () => {
    const result = await runLoop(5, { maxSteps: 25 });
    expect(result.output).toHaveLength(5);
  });

  it('clamps the default 100 when a run ceiling is present', async () => {
    const result = await runLoop(undefined, { maxSteps: 3 });
    expect(result.output).toHaveLength(3);
  });
});
