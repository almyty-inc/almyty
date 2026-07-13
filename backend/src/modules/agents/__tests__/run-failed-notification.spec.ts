import { AgentExecutionEngine } from '../agent-execution.engine';
import { AgentExecutionStatus } from '../../../entities/agent-execution.entity';

/**
 * run.failed notification wiring: emitted only for unattended runs
 * (metadata.triggerType 'scheduled' or 'webhook'), never for
 * interactive Try-It invocations, and only to the run's initiator.
 *
 * Drives the engine through its generic failure path (an agent with no
 * configured pipeline throws inside execute()'s try block, landing in
 * the catch that finalizes the execution as FAILED).
 */
describe('AgentExecutionEngine run.failed notification', () => {
  let agentRepo: any;
  let executionRepo: any;
  let state: any;
  let webhook: any;
  let notifications: { emit: jest.Mock };

  function makeEngine(withNotifications = true) {
    agentRepo = { findOne: jest.fn(), save: jest.fn() };
    executionRepo = {
      create: jest.fn((data: any) => ({ id: 'exec-1', ...data })),
      save: jest.fn(async (e: any) => e),
    };
    state = {
      emitEvent: jest.fn(),
      bumpAgentStats: jest.fn().mockResolvedValue(undefined),
    };
    webhook = { sendExecutionWebhook: jest.fn().mockResolvedValue(undefined) };
    notifications = { emit: jest.fn().mockResolvedValue(undefined) };
    return new AgentExecutionEngine(
      agentRepo,
      executionRepo,
      {} as any, // nodeExecutor — unreached on the no-pipeline failure path
      webhook,
      state,
      withNotifications ? (notifications as any) : undefined,
    );
  }

  const brokenAgent = { id: 'agent-1', name: 'Nightly Sync', pipeline: null } as any;

  async function runFailing(engine: AgentExecutionEngine, metadata: any, userId: any = 'user-1') {
    const execution = await engine.execute(
      brokenAgent,
      'org-1',
      userId,
      { input: {}, metadata },
    );
    // Let the fire-and-forget notify promise settle.
    await new Promise((r) => setImmediate(r));
    return execution;
  }

  it('notifies the initiator for a scheduled run that fails', async () => {
    const engine = makeEngine();
    const execution = await runFailing(engine, { triggerType: 'scheduled' });

    expect(execution.status).toBe(AgentExecutionStatus.FAILED);
    expect(notifications.emit).toHaveBeenCalledTimes(1);
    const input = notifications.emit.mock.calls[0][0];
    expect(input).toMatchObject({
      type: 'run.failed',
      organizationId: 'org-1',
      userIds: ['user-1'],
      link: '/agents/agent-1',
    });
    expect(input.title).toContain('Nightly Sync');
    expect(input.email.template).toBe('run.failed');
    expect(input.email.params.triggerType).toBe('scheduled');
  });

  it('notifies for webhook-triggered runs too', async () => {
    const engine = makeEngine();
    await runFailing(engine, { triggerType: 'webhook' });
    expect(notifications.emit).toHaveBeenCalledTimes(1);
  });

  it('does NOT notify for interactive (Try-It) runs without a triggerType', async () => {
    const engine = makeEngine();
    const execution = await runFailing(engine, {});
    expect(execution.status).toBe(AgentExecutionStatus.FAILED);
    expect(notifications.emit).not.toHaveBeenCalled();
  });

  it('does NOT notify when the run has no initiator', async () => {
    const engine = makeEngine();
    await runFailing(engine, { triggerType: 'scheduled' }, null);
    expect(notifications.emit).not.toHaveBeenCalled();
  });

  it('works without the notifications pipeline (community/unit builds)', async () => {
    const engine = makeEngine(false);
    const execution = await runFailing(engine, { triggerType: 'scheduled' });
    expect(execution.status).toBe(AgentExecutionStatus.FAILED);
  });

  it('a notification failure never affects the execution result', async () => {
    const engine = makeEngine();
    notifications.emit.mockRejectedValue(new Error('pipeline down'));
    const execution = await runFailing(engine, { triggerType: 'scheduled' });
    expect(execution.status).toBe(AgentExecutionStatus.FAILED);
  });
});
