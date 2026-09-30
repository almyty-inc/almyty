jest.mock('../../llm-providers/providers/safe-request', () => ({
  ...jest.requireActual('../../llm-providers/providers/safe-request'),
  callLlmProviderHttpStream: jest.fn(),
}));
jest.mock('axios', () => {
  const fn: any = jest.fn();
  fn.isAxiosError = () => false;
  return { __esModule: true, default: fn, isAxiosError: () => false };
});

import axios from 'axios';

import { AgentRunStatus } from '../../../entities/agent-run.entity';
import { membershipFixture } from '../../../test/execution-access.fixture';
import { REFUND_TOOL, gatedExecutor } from '../../tools/__tests__/gated-executor.harness';
import { anthropicText, anthropicTool, runAgent } from './autonomous-harness';

/**
 * The autonomous runtime and an approval policy's amount rule, end to
 * end: the model asks for a refund over the amount, the real executor
 * holds the call, the run asks a person and waits; once they approve, the
 * very call the model made runs and the model carries on with its result.
 * Under the amount, nobody is asked.
 */
describe('approval over an amount in an autonomous agent', () => {
  const mockedAxios = axios as unknown as jest.Mock;
  const MODEL = 'claude-sonnet-5';
  let harness: ReturnType<typeof gatedExecutor>;
  let approvals: { create: jest.Mock };

  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ status: 200, data: { refunded: true, id: 're_1' }, headers: {} });
    const access = membershipFixture();
    access.member('org-1', 'u-1');
    harness = gatedExecutor(access.executionAccess);
    // The approvals service's create, over the table the gate reads.
    approvals = {
      create: jest.fn(async (input: any) =>
        harness.approvalRequests.save({ ...input, status: 'pending', principal: undefined }),
      ),
    };
  });

  const start = (amount: number) =>
    runAgent({
      models: null,
      agent: { toolIds: ['tool-refund'] },
      tools: [REFUND_TOOL],
      approvals,
      executeTool: jest.fn((toolId: string, params: any, options: any) => harness.executor.executeTool(toolId, params, options)),
      streams: {
        [MODEL]: [
          anthropicTool(MODEL, 'issue_refund', { amount, order: 'NW-44120' }, 120, 20),
          anthropicText(MODEL, 180, ['The refund has been issued.'], 12),
        ],
      },
    });

  it('runs a refund under the amount without asking anyone', async () => {
    const result = await start(120);
    expect(approvals.create).not.toHaveBeenCalled();
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    expect(result.run.status).toBe(AgentRunStatus.COMPLETED);
  });

  it('holds a refund over the amount for a person, then makes exactly that call once they approve', async () => {
    const result = await start(820);

    // Held: nothing sent, a person asked with the call and the rule.
    expect(mockedAxios).not.toHaveBeenCalled();
    expect(result.run.status).toBe(AgentRunStatus.WAITING_APPROVAL);
    expect(approvals.create).toHaveBeenCalledTimes(1);
    const asked = approvals.create.mock.calls[0][0];
    expect(asked).toMatchObject({
      runId: 'run-1',
      agentId: 'agent-1',
      reason: 'Ask before issue_refund when amount is over 500. On this call amount is 820.',
      payload: { tool: 'issue_refund', parameters: { amount: 820, order: 'NW-44120' }, _gate: { policyId: 'policy-refunds', value: 820 } },
    });
    expect(result.run.workingMemory.gatedToolCalls).toHaveLength(1);
    expect(harness.audit.log).toHaveBeenCalledWith(expect.objectContaining({ status: 'held' }));

    // A second look while it is still pending changes nothing.
    await result.runRepository.update({ id: 'run-1' }, { status: AgentRunStatus.RUNNING });
    await result.drive();
    expect(mockedAxios).not.toHaveBeenCalled();
    expect(result.runRepository.row('run-1')!.status).toBe(AgentRunStatus.WAITING_APPROVAL);

    // Approved (what ApprovalsService.decide and the runtime's listener do).
    const [row] = await harness.approvalRequests.find({ where: { runId: 'run-1' } });
    await harness.approvalRequests.update({ id: row.id }, { status: 'approved' });
    await result.runRepository.update({ id: 'run-1' }, { status: AgentRunStatus.RUNNING });
    await result.drive();

    expect(mockedAxios).toHaveBeenCalledTimes(1);
    expect(mockedAxios.mock.calls[0][0]).toMatchObject({ data: expect.objectContaining({ amount: 820, order: 'NW-44120' }) });
    const run = result.runRepository.row('run-1')!;
    expect(run.status).toBe(AgentRunStatus.COMPLETED);
    expect(run.output).toContain('The refund has been issued.');
    expect(run.workingMemory.gatedToolCalls).toBeUndefined();
    expect(harness.audit.log).toHaveBeenCalledWith(expect.objectContaining({ status: 'approved' }));
  });
});
