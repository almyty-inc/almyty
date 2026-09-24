import { membershipFixture } from '../../../test/execution-access.fixture';
import { gatewayPrincipal } from '../../../common/authorization/execution-access.service';
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
      undefined, // strategyPipelines
      undefined, // agentRoles
      undefined, // organizationRepository
      undefined, // budgets
      undefined, // cancellations
      membershipFixture().executionAccess, // the real execution gate
    );
  }

  const brokenAgent = { id: 'agent-1', name: 'Nightly Sync', pipeline: null } as any;

  async function runFailing(
    engine: AgentExecutionEngine,
    metadata: any,
    userId: any = 'user-1',
    agent: any = brokenAgent,
  ) {
    const execution = await engine.execute(
      agent,
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

  // A private agent's failure (its name and error text) is its owner's
  // alone. The run's userId is what the surface stamped -- a run through
  // the owner's private gateway carries no user of its own -- so the owner
  // is who hears about it.
  describe('on a private agent', () => {
    const privateAgent = (createdBy: string | null) =>
      ({ ...brokenAgent, organizationId: 'org-1', visibility: 'private', createdBy }) as any;
    // The only surface a private agent runs through without its owner's
    // own session: a gateway private to that owner.
    const ownersGateway = (owner: string) =>
      gatewayPrincipal({ id: 'gw-1', organizationId: 'org-1', visibility: 'private', ownerUserId: owner });

    it('notifies the owner, not the user the run was stamped with', async () => {
      const engine = makeEngine();
      await engine.execute(privateAgent('owner-9'), 'org-1', 'user-1', {
        input: {},
        metadata: { triggerType: 'scheduled' },
        principal: ownersGateway('owner-9'),
      });
      await new Promise((r) => setImmediate(r));
      expect(notifications.emit).toHaveBeenCalledTimes(1);
      expect(notifications.emit.mock.calls[0][0].userIds).toEqual(['owner-9']);
    });

    it('notifies the owner when the run carries no user at all', async () => {
      const engine = makeEngine();
      await engine.execute(privateAgent('owner-9'), 'org-1', null, {
        input: {},
        metadata: { triggerType: 'webhook' },
        principal: ownersGateway('owner-9'),
      });
      await new Promise((r) => setImmediate(r));
      expect(notifications.emit.mock.calls[0][0].userIds).toEqual(['owner-9']);
    });

    it('a private agent with no recorded owner runs for nobody, so nobody is notified', async () => {
      const engine = makeEngine();
      await expect(runFailing(engine, { triggerType: 'scheduled' }, 'user-1', privateAgent(null))).rejects.toThrow(
        'Agent not found',
      );
      expect(notifications.emit).not.toHaveBeenCalled();
    });
  });
});
