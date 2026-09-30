import axios from 'axios';

import { AgentExecutionEngine } from '../agent-execution.engine';
import { AgentNodeExecutor } from '../agent-node-executor';
import { AgentSubAgentExecutors } from '../agent-subagent-executors.helper';
import { AgentTemplateResolver } from '../agent-template-resolver';
import { Agent, AgentStatus } from '../../../entities/agent.entity';
import { AgentExecution, AgentExecutionStatus } from '../../../entities/agent-execution.entity';
import { fakeRepository } from '../../../test/fake-repository';
import { membershipFixture } from '../../../test/execution-access.fixture';
import { userPrincipal } from '../../../common/authorization/execution-access.service';
import { gatedExecutor } from '../../tools/__tests__/gated-executor.harness';

jest.mock('axios', () => {
  const fn: any = jest.fn();
  fn.isAxiosError = () => false;
  return { __esModule: true, default: fn, isAxiosError: () => false };
});

/**
 * The workflow engine and an approval policy's amount rule, end to end:
 * AgentExecutionEngine -> AgentNodeExecutor (tool_call) -> the real
 * ToolExecutorService and gate. A workflow cannot pause for a person, so a
 * call over the amount is refused -- the refund is not made and the run
 * says why -- while a call under it runs without asking.
 */
describe('approval over an amount in a workflow agent', () => {
  const mockedAxios = axios as unknown as jest.Mock;
  let engine: AgentExecutionEngine;
  let agents: any;
  let harness: ReturnType<typeof gatedExecutor>;

  const refundAgent = () =>
    Object.assign(new Agent(), {
      id: 'refund-agent',
      name: 'Refunds',
      organizationId: 'org-1',
      status: AgentStatus.ACTIVE,
      mode: 'workflow',
      visibility: 'org',
      teamId: null,
      createdBy: 'u-1',
      settings: {},
      pipeline: {
        nodes: [
          {
            id: 'refund',
            type: 'tool_call',
            label: 'Refund',
            position: { x: 0, y: 0 },
            data: { toolId: 'tool-refund', parameterMapping: { amount: '{{input.amount}}', order: '{{input.order}}' } },
          },
          { id: 'out', type: 'output', label: 'Output', position: { x: 0, y: 0 }, data: { mapping: 'done' } },
        ],
        edges: [{ id: 'e1', source: 'refund', target: 'out' }],
      },
    });

  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ status: 200, data: { refunded: true }, headers: {} });
    const access = membershipFixture();
    access.member('org-1', 'u-1');
    harness = gatedExecutor(access.executionAccess);
    agents = fakeRepository<Agent>({ seed: [refundAgent()], make: () => new Agent() });
    const executions = fakeRepository<AgentExecution>({ make: () => new AgentExecution(), idPrefix: 'exec' });
    const state = {
      emitEvent: jest.fn(),
      bumpAgentStats: jest.fn().mockResolvedValue(undefined),
      withTimeout: (promise: Promise<unknown>) => promise,
    };
    engine = new AgentExecutionEngine(
      agents as any,
      executions as any,
      null as any,
      { sendExecutionWebhook: jest.fn().mockResolvedValue(undefined) } as any,
      state as any,
      undefined, undefined, undefined, undefined, undefined, undefined,
      access.executionAccess,
    );
    const resolver = new AgentTemplateResolver();
    const subAgents = new AgentSubAgentExecutors(resolver, agents as any, engine, {} as any, {} as any);
    (engine as any).nodeExecutor = new AgentNodeExecutor(resolver, {} as any, harness.executor, agents as any, engine, {} as any, {} as any, subAgents, {} as any);
  });

  const run = (input: Record<string, any>) =>
    engine.execute(agents.row('refund-agent')!, 'org-1', 'u-1', { input, principal: userPrincipal('u-1') });

  it('runs a refund under the amount without asking', async () => {
    const execution = await run({ amount: 120, order: 'NW-1' });
    expect(execution.status).toBe(AgentExecutionStatus.COMPLETED);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
  });
  it('holds a refund over the amount for a person: the run stops waiting, and the refund is made once approved', async () => {
    const execution = await run({ amount: 820, order: 'NW-44120' });
    // A workflow cannot pause: the run stops, and says it is waiting and on what.
    expect(execution.status).toBe(AgentExecutionStatus.FAILED);
    expect(execution.error).toContain('Waiting for approval: Ask before “Issue refund” when amount is over 500 (amount is 820)');
    const refund = execution.nodeResults.refund;
    expect(refund.errorCode).toBe('AWAITING_APPROVAL');
    const [asked] = harness.approvals.created;
    expect(refund.input.approvalId).toBe(asked.id);
    expect(mockedAxios).not.toHaveBeenCalled();
    expect(harness.audit.log).toHaveBeenCalledWith(expect.objectContaining({ status: 'held' }));

    // Approved in Approvals: the held refund runs, exactly as the workflow asked for it.
    await harness.approvals.decide(asked.id, 'approved');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    // The parameters as the workflow resolved them (its templates give text).
    expect(mockedAxios.mock.calls[0][0]).toMatchObject({ data: { amount: '820', order: 'NW-44120' } });
  });
});
