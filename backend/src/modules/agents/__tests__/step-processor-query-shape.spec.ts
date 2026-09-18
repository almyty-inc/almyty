import { getMetadataArgsStorage } from 'typeorm';

import {
  AgentStepProcessor,
  AGENT_STEP_COLUMNS,
  AGENT_STEP_COLUMNS_OMITTED,
} from '../agent-step-processor';
import { Agent } from '../../../entities/agent.entity';
import { AgentRunStatus } from '../../../entities/agent-run.entity';
import { STEP_PAYLOAD_CAP } from '../persist-cap';

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
    const runRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
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
    expect([...AGENT_STEP_COLUMNS_OMITTED]).toEqual(['pipeline', 'metadata']);
  });

  it('narrows the joined agent when it loads the run', async () => {
    const { processor, runRepository } = makeProcessor();

    await processor.processStep('run-1');

    expect(runRepository.findOne).toHaveBeenCalledTimes(1);
    const options = runRepository.findOne.mock.calls[0][0];
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

  it('still truncates an oversized payload', () => {
    const { processor } = makeProcessor();
    const steps = [
      { type: 'tool', input: {}, output: { blob: 'z'.repeat(STEP_PAYLOAD_CAP * 2) }, timestamp: '1' },
    ];

    const [capped] = (processor as any).boundStepsForPersist(steps);

    expect(typeof capped.output).toBe('string');
    expect(capped.output).toContain('truncated from');
    // The in-memory array the tick reasons over is untouched.
    expect(typeof steps[0].output).toBe('object');
  });
});
