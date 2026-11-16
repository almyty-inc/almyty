import { getMetadataArgsStorage } from 'typeorm';

import {
  AgentStepProcessor,
  AGENT_STEP_COLUMNS,
  AGENT_STEP_COLUMNS_OMITTED,
} from '../agent-step-processor';
import { Agent } from '../../../entities/agent.entity';
import { AgentRun, AgentRunStatus } from '../../../entities/agent-run.entity';
import { STEP_PAYLOAD_CAP } from '../persist-cap';
import { StepJournal } from '../run-resume';

/**
 * What one autonomous step costs in queries and in serialization.
 *
 * Per step the processor used to: load the run with the WHOLE agent row
 * joined (pipeline + the inline version history), load the organization
 * twice with the identical query ~80 lines apart, re-fetch the same tool set,
 * and re-cap every prior step's payload on commit (Σk = N²/2 stringifies for
 * an N-step run).
 */
describe('AgentStepProcessor query and serialization shape', () => {
  const makeProcessor = (overrides: any = {}) => {
    const runRepository: any = {
      // The lease claim locks the row (a run nobody holds); the step's own load finds nothing.
      findOne: jest.fn(async (o: any) => (o?.lock ? Object.assign(new AgentRun(), { id: 'run-1', status: AgentRunStatus.RUNNING, currentStep: 0, headSeq: 0, leaseOwner: null }) : null)),
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    // The commit writes the row (this update) and its run events in one transaction.
    runRepository.manager = {
      transaction: async (work: any) => work({ getRepository: (entity: any) => (entity === AgentRun ? runRepository : { insert: jest.fn() }) }),
    };
    const organizationRepository = { findOne: jest.fn().mockResolvedValue({ id: 'org-1' }) };
    const toolRepository = { find: jest.fn().mockResolvedValue([{ id: 't-1', name: 'a' }]) };
    const s: any = {
      logger: { warn: jest.fn(), debug: jest.fn(), log: jest.fn() },
      runRepository,
      organizationRepository,
      toolRepository,
      misc: { resolveLimits: jest.fn().mockResolvedValue({}) },
      emitEvent: jest.fn(),
      ...overrides,
    };
    const processor = new AgentStepProcessor(s, {} as any, {} as any, {} as any);
    return { processor, s, runRepository, organizationRepository, toolRepository };
  };

  it('classifies every Agent column as either loaded or deliberately omitted', () => {
    const declared = getMetadataArgsStorage()
      .columns.filter((c) => c.target === Agent)
      .map((c) => c.propertyName);

    expect(declared.length).toBeGreaterThan(0);
    const accounted = new Set<string>([
      ...Object.keys(AGENT_STEP_COLUMNS),
      ...AGENT_STEP_COLUMNS_OMITTED,
    ]);
    const unclassified = declared.filter((name) => !accounted.has(name));
    expect(unclassified).toEqual([]);
  });

  it('never loads the agent pipeline or metadata on the step path', () => {
    expect(AGENT_STEP_COLUMNS).not.toHaveProperty('pipeline');
    expect(AGENT_STEP_COLUMNS).not.toHaveProperty('metadata');
    expect([...AGENT_STEP_COLUMNS_OMITTED]).toEqual(['pipeline', 'metadata', 'branding', 'visitorRules', 'apiGatewayId', 'apiAccessScope', 'apiAccessTeamId']);
  });

  it('narrows the joined agent when it loads the run', async () => {
    const { processor, runRepository } = makeProcessor();

    await processor.processStep('run-1');

    // The run is loaded once for the step; the other reads are the lease's
    // claim and release (run-lease.ts), which lock the row and read only the
    // lease columns, never the run's steps or memory. `takeovers` is one: the
    // claim adds one to the locked row's count to cap takeovers of a step.
    const loads = runRepository.findOne.mock.calls.filter(([o]: any[]) => !o.lock);
    expect(loads).toHaveLength(1);
    const leaseReads = runRepository.findOne.mock.calls.filter(([o]: any[]) => o.lock);
    expect(leaseReads).toHaveLength(2);
    for (const [o] of leaseReads) expect(Object.keys(o.select).sort()).toEqual(['attempt', 'currentStep', 'headSeq', 'id', 'leaseExpiresAt', 'leaseOwner', 'nextWakeAt', 'status', 'takeovers']);
    const options = loads[0][0];
    expect(options.relations).toEqual({ agent: true });
    expect(options.select.agent).toBeDefined();
    expect(options.select.agent.pipeline).toBeUndefined();
    expect(options.select.agent.metadata).toBeUndefined();
    expect(options.select.agent.id).toBe(true);
    expect(options.select.agent.toolIds).toBe(true);
  });

  it('loads the organization once per step and hands it to resolveLimits', async () => {
    const organization = { id: 'org-1', settings: {} };
    const run: any = {
      id: 'run-1',
      organizationId: 'org-1',
      currentStep: 0,
      status: AgentRunStatus.RUNNING,
      steps: [],
      metadata: {},
      totalCost: 0,
      totalTokens: 0,
      isDone: () => false,
      agent: { id: 'a-1', organizationId: 'org-1', toolIds: [] },
    };
    const { processor, s, organizationRepository } = makeProcessor();
    s.runRepository.findOne.mockResolvedValue(run);
    organizationRepository.findOne.mockResolvedValue(organization);
    // Trip the limit check so the step returns before the model call —
    // everything under test has already happened by then.
    s.misc.resolveLimits.mockResolvedValue({ maxSteps: 0 });

    await processor.processStep('run-1');

    // Was two identical findOnes ~80 lines apart.
    expect(organizationRepository.findOne).toHaveBeenCalledTimes(1);
    expect(organizationRepository.findOne).toHaveBeenCalledWith({ where: { id: 'org-1' } });
    expect(s.misc.resolveLimits).toHaveBeenCalledWith(run, organization);
  });

  it('resolves the same tool set once across steps instead of once per step', async () => {
    const { processor, toolRepository } = makeProcessor();
    const agent: any = { id: 'a-1', organizationId: 'org-1', toolIds: ['t-1', 't-2'] };

    const first = await (processor as any).resolveTools(agent);
    const second = await (processor as any).resolveTools(agent);
    const third = await (processor as any).resolveTools({ ...agent, toolIds: ['t-2', 't-1'] });

    // Was one query per step; now one per (org, toolIds) per TTL window,
    // and the key is order-insensitive.
    expect(toolRepository.find).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(third).toBe(first);

    // A different org is a different key.
    await (processor as any).resolveTools({ ...agent, organizationId: 'org-2' });
    expect(toolRepository.find).toHaveBeenCalledTimes(2);
  });

  it('asks for no tools at all when the agent has none', async () => {
    const { processor, toolRepository } = makeProcessor();
    await expect((processor as any).resolveTools({ id: 'a', organizationId: 'o', toolIds: [] }))
      .resolves.toEqual([]);
    expect(toolRepository.find).not.toHaveBeenCalled();
  });

  it('caps each step exactly once however many times the run commits', () => {
    const { processor } = makeProcessor();
    const steps = [
      { type: 'llm', input: { a: 'x'.repeat(10) }, output: { b: 1 }, timestamp: '1' },
      { type: 'tool', input: { c: 2 }, output: { d: 3 }, timestamp: '2' },
    ];

    const first = (processor as any).boundStepsForPersist(steps);
    const second = (processor as any).boundStepsForPersist(steps);
    const third = (processor as any).boundStepsForPersist(steps);

    // Identity, not just equality: the capped payload is computed once per
    // step object and reused, so commit k does not re-serialize steps 0..k-1.
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(third[0]).toBe(first[0]);

    // A newly appended step is capped on its first commit only.
    const appended = { type: 'llm', input: { e: 4 }, output: { f: 5 }, timestamp: '3' };
    const fourth = (processor as any).boundStepsForPersist([...steps, appended]);
    expect(fourth[0]).toBe(first[0]);
    expect(fourth[2]).not.toBe(appended);
    expect((processor as any).boundStepsForPersist([...steps, appended])[2]).toBe(fourth[2]);
  });

  it('still bounds an oversized payload', () => {
    const { processor } = makeProcessor();
    const steps = [
      { type: 'tool', input: {}, output: { blob: 'z'.repeat(STEP_PAYLOAD_CAP * 2) }, timestamp: '1' },
    ];

    const [capped] = (processor as any).boundStepsForPersist(steps);

    // A JSON payload is shortened, not cut: still an object, with a note.
    expect(JSON.stringify(capped.output).length).toBeLessThanOrEqual(STEP_PAYLOAD_CAP);
    expect(capped.output._shortened).toContain('[result shortened');
    // The in-memory array the tick reasons over is untouched.
    expect(steps[0].output.blob).toHaveLength(STEP_PAYLOAD_CAP * 2);
  });

  it('reads the step\'s own progress back with one bounded read of the log, newest first, never the whole log', async () => {
    // Durable runs step 4 (run-resume.ts): the step's events are the log's
    // tail; the previous step's commit ends it, normally in the first page.
    const page = [
      { runId: 'run-1', seq: 9, step: 3, type: 'tool_started', payload: { callIndex: 0 } },
      { runId: 'run-1', seq: 8, step: 3, type: 'model_answered', payload: { messageCount: 4, response: {} } },
      { runId: 'run-1', seq: 7, step: 2, type: 'step_committed', payload: { currentStep: 3 } },
    ];
    const events = { find: jest.fn().mockResolvedValue(page) };
    const runs: any = { manager: { getRepository: () => events } };

    const journal = await StepJournal.read(runs, { id: 'run-1', currentStep: 3, headSeq: 9, leaseOwner: 'w' } as any);

    expect(events.find).toHaveBeenCalledTimes(1);
    expect(events.find).toHaveBeenCalledWith({ where: { runId: 'run-1' }, order: { seq: 'DESC' }, take: 100 });
    expect(journal.answer).toMatchObject({ messageCount: 4 });
    expect(journal.wasStarted(0)).toBe(true);
  });
});
