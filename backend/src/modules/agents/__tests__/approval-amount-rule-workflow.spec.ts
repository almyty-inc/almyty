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
import { WorkflowApprovalResumeService } from '../workflow-approval-resume.service';

jest.mock('axios', () => {
  const fn: any = jest.fn();
  fn.isAxiosError = () => false;
  return { __esModule: true, default: fn, isAxiosError: () => false };
});

/**
 * The workflow engine and an approval policy's amount rule, end to end:
 * AgentExecutionEngine -> AgentNodeExecutor (tool_call) -> the real
 * ToolExecutorService and gate. A call over the amount waits for a person:
 * the run waits with it, then carries on with the call's result once
 * approved, or ends "Rejected" -- while a call under it runs without asking.
 */
describe('approval over an amount in a workflow agent', () => {
  const mockedAxios = axios as unknown as jest.Mock;
  let engine: AgentExecutionEngine;
  let agents: any;
  let harness: ReturnType<typeof gatedExecutor>;
  let executions: any;

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
    executions = fakeRepository<AgentExecution>({ make: () => new AgentExecution(), idPrefix: 'exec' });
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
    // Carries a waiting run on once its call is decided, subscribed as Nest does at start-up.
    new WorkflowApprovalResumeService(executions as any, agents as any, engine, harness.approvals as any).onModuleInit();
  });

  const run = (input: Record<string, any>) =>
    engine.execute(agents.row('refund-agent')!, 'org-1', 'u-1', { input, principal: userPrincipal('u-1') });

  it('runs a refund under the amount without asking', async () => {
    const execution = await run({ amount: 120, order: 'NW-1' });
    expect(execution.status).toBe(AgentExecutionStatus.COMPLETED);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
  });
  /** Let the gate's decision handler, the call it makes and the run carrying on all finish. */
  const settle = async () => {
    for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve));
  };

  it('holds a refund over the amount for a person: the run waits, saying what for in plain words', async () => {
    const execution = await run({ amount: 820, order: 'NW-44120' });
    expect(execution.status).toBe(AgentExecutionStatus.WAITING_APPROVAL);
    expect(execution.error).toBe('Waiting for your approval: Issue refund (amount is 820).');
    expect(execution.error).not.toMatch(/_approvalId|call again/);
    const refund = execution.nodeResults.refund;
    expect(refund).toMatchObject({ status: 'waiting_approval', waitingForApproval: { kind: 'tool_call', changes: 1 } });
    expect(refund.error).toBeUndefined();
    const [asked] = harness.approvals.created;
    expect(refund.input.approvalId).toBe(asked.id);
    expect(execution.nodeResults.out).toMatchObject({ skipped: true });
    expect(mockedAxios).not.toHaveBeenCalled();
    expect(harness.audit.log).toHaveBeenCalledWith(expect.objectContaining({ status: 'held' }));
  });

  it('approved: the refund is made once, exactly as asked, and the run carries on to the end with its result', async () => {
    const execution = await run({ amount: 820, order: 'NW-44120' });
    const [asked] = harness.approvals.created;
    await harness.approvals.decide(asked.id, 'approved');
    await settle();
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    // The parameters as the workflow resolved them (its templates give text).
    expect(mockedAxios.mock.calls[0][0]).toMatchObject({ data: { amount: '820', order: 'NW-44120' } });
    const after = executions.row(execution.id)!;
    expect(after.status).toBe(AgentExecutionStatus.COMPLETED);
    expect(after.error).toBeNull();
    expect(after.nodeResults.refund.output).toEqual({ refunded: true });
    expect(after.output).toBe('done');
  });

  it('two runs waiting on the same refund both carry on, and the refund is still made once', async () => {
    const first = await run({ amount: 820, order: 'NW-44120' });
    const second = await run({ amount: 820, order: 'NW-44120' });
    expect(harness.approvals.created).toHaveLength(1);
    await harness.approvals.decide(harness.approvals.created[0].id, 'approved');
    await settle();
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    expect(executions.row(first.id)!.status).toBe(AgentExecutionStatus.COMPLETED);
    expect(executions.row(second.id)!.status).toBe(AgentExecutionStatus.COMPLETED);
  });

  it('rejected: the refund is not made and the step ends with a plain "Rejected"', async () => {
    const execution = await run({ amount: 820, order: 'NW-44120' });
    await harness.approvals.decide(harness.approvals.created[0].id, 'rejected', 'customer already refunded');
    await settle();
    expect(mockedAxios).not.toHaveBeenCalled();
    const after = executions.row(execution.id)!;
    expect(after.status).toBe(AgentExecutionStatus.CANCELLED);
    expect(after.error).toBe('Rejected (customer already refunded). The call was not made.');
    expect(after.nodeResults.refund).toMatchObject({ errorCode: 'APPROVAL_REJECTED' });
  });

  it('nobody decided in time: the call is not made and the run says so', async () => {
    const execution = await run({ amount: 820, order: 'NW-44120' });
    await harness.approvals.decide(harness.approvals.created[0].id, 'expired', 'approval expired');
    await settle();
    expect(mockedAxios).not.toHaveBeenCalled();
    expect(executions.row(execution.id)!.error).toBe('Nobody approved in time. The call was not made.');
  });

  it('approved, but the call fails: the step fails saying so', async () => {
    const execution = await run({ amount: 820, order: 'NW-44120' });
    mockedAxios.mockRejectedValue(Object.assign(new Error('billing is down'), { response: { status: 503, data: 'billing is down' } }));
    await harness.approvals.decide(harness.approvals.created[0].id, 'approved');
    await settle();
    const after = executions.row(execution.id)!;
    expect(after.status).toBe(AgentExecutionStatus.FAILED);
    expect(after.nodeResults.refund.error).toMatch(/^Approved, but the call failed/);
  });
});
