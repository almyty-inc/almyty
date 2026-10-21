jest.mock('../../llm-providers/providers/safe-request', () => ({
  ...jest.requireActual('../../llm-providers/providers/safe-request'),
  callLlmProviderHttpStream: jest.fn(),
}));

import { AgentRunStatus } from '../../../entities/agent-run.entity';
import { anthropicText, anthropicTool, runAgent } from './autonomous-harness';

/**
 * A run whose shell tool hits a hosted machine that is still starting, or
 * one that cannot start. The design (hosted-runners-and-always-on.md,
 * "Waking") gives the call a retryable `workspace_waking` result and puts
 * the run to sleep within the wake budget; the call is what is retried,
 * not left to the model, which used to read "try again shortly", answer,
 * and leave the run "completed" with nothing run. A machine that failed,
 * or was not up within the budget, fails the run with its problem named.
 */
describe('a run on a hosted machine that is waking or failed', () => {
  const MODEL = 'claude-sonnet-5';
  const TLS = 'Get "https://k8s.example:6443/api/v1/namespaces": tls: failed to verify certificate: x509: certificate signed by unknown authority';

  const waking = () => ({
    success: false,
    error: 'workspace_waking: The machine for this environment is starting; try the call again shortly.',
    executionTime: 2,
    cached: false,
    rateLimited: false,
    retryCount: 0,
    metadata: { runnerErrorCode: 'workspace_waking', retryAfterMs: 10_000, retryable: true },
  });
  const failed = () => ({
    success: false,
    error: 'workspace_unavailable: The machine for this environment did not start within 180 seconds',
    executionTime: 2,
    cached: false,
    rateLimited: false,
    retryCount: 0,
    metadata: { runnerErrorCode: 'workspace_unavailable', machineFailed: true, machineError: `${TLS} (Authorization: Bearer abc.def.ghi)` },
  });
  const ran = () => ({ success: true, data: { stdout: 'README.md\n' }, executionTime: 4, cached: false, rateLimited: false, retryCount: 0 });
  let sleeps: Array<Record<string, any>>;
  beforeEach(() => {
    sleeps = [];
  });

  const start = (executeTool: jest.Mock, streams = [anthropicTool(MODEL, 'crm_lookup', { account: '4411' }, 120, 20), anthropicText(MODEL, 180, ['The repository has a README.'], 12)]) =>
    runAgent({ models: null, executeTool, sleeps, streams: { [MODEL]: streams } });

  it('makes the waking call again itself, and the model only ever sees its real result', async () => {
    const executeTool = jest.fn().mockResolvedValueOnce(waking()).mockResolvedValueOnce(ran());
    const result = await start(executeTool);

    // Asleep, the call held for the next step, the model not asked again.
    expect(result.run.status).not.toBe(AgentRunStatus.COMPLETED);
    expect(result.run.workingMemory.wakingToolCalls).toEqual([expect.objectContaining({ toolId: 'tool-crm', parameters: { account: '4411' } })]);
    expect(result.bodies).toHaveLength(1);
    expect(sleeps).toEqual([{ seconds: 10 }]);

    await result.drive();

    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(executeTool.mock.calls[1][0]).toBe('tool-crm');
    expect(executeTool.mock.calls[1][1]).toEqual({ account: '4411' });
    const run = result.runRepository.row('run-1')!;
    expect(run.status).toBe(AgentRunStatus.COMPLETED);
    expect(run.workingMemory.wakingToolCalls).toBeUndefined();
    const second = JSON.stringify(result.bodies[1].body);
    expect(second).toContain('README.md');
    expect(second).not.toContain('workspace_waking');
  });

  it('fails the run, naming the machine problem, when the machine does not come up', async () => {
    const executeTool = jest.fn().mockResolvedValueOnce(waking()).mockResolvedValueOnce(failed());
    const result = await start(executeTool);
    await result.drive();

    const run = result.runRepository.row('run-1')!;
    expect(run.status).toBe(AgentRunStatus.FAILED);
    expect(run.error).toBe("The hosted machine for this run couldn't start: Can't reach the cluster: its certificate isn't trusted.");
    expect(run.metadata.machineFailure).toMatchObject({ summary: "Can't reach the cluster: its certificate isn't trusted" });
    expect(run.metadata.machineFailure.detail).toContain('x509');
    expect(run.metadata.machineFailure.detail).not.toContain('abc.def.ghi');
    // The model was not asked to answer around a call that never ran.
    expect(result.bodies).toHaveLength(1);
    const step = run.steps.find((s: any) => s.type === 'tool_call' && s.output?.machineError);
    expect(step?.output.machineError.summary).toBe("Can't reach the cluster: its certificate isn't trusted");
  });

  it('fails the run at once when the machine had already failed', async () => {
    const executeTool = jest.fn().mockResolvedValueOnce(failed());
    const result = await start(executeTool);

    expect(result.run.status).toBe(AgentRunStatus.FAILED);
    expect(result.run.error).toContain("Can't reach the cluster: its certificate isn't trusted");
    expect(result.bodies).toHaveLength(1);
    expect(result.events.map((e) => e.type)).toContain('run.failed');
  });
});
