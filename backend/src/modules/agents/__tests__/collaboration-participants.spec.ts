import { BadRequestException } from '@nestjs/common';

import { AgentStepProcessor } from '../agent-step-processor';
import { AgentRunStatus } from '../../../entities/agent-run.entity';
import { AgentsService } from '../agents.service';
import { buildCollaborationContext, collaborationProblems } from '../collaboration-participants';
import { LlmProvider } from '../../../entities/llm-provider.entity';

describe('collaborationProblems', () => {
  it('accepts no collaboration, agent participants, and model participants by provider or routing', () => {
    expect(collaborationProblems(null)).toEqual([]);
    expect(collaborationProblems(undefined)).toEqual([]);
    expect(
      collaborationProblems({
        strategy: 'debate',
        participants: [
          { kind: 'agent', agentId: 'a1', role: 'pro' },
          { kind: 'model', providerId: 'p1', model: 'm1' },
          { kind: 'model', providerId: 'p2' }, // provider default model
          { kind: 'model', routing: { objective: 'cheapest' } },
        ],
        judge: { kind: 'model', routing: {} },
        maxRounds: 2,
      }),
    ).toEqual([]);
  });

  it('names an unknown strategy', () => {
    expect(collaborationProblems({ strategy: 'telepathy', participants: [] })).toEqual([
      'collaboration.strategy "telepathy" is not one of sequential, parallel, race, debate',
    ]);
  });

  it('names a participant with an unknown kind', () => {
    expect(
      collaborationProblems({ strategy: 'parallel', participants: [{ kind: 'human', agentId: 'x' }] }),
    ).toEqual(['collaboration.participants[0] has unknown kind "human" (expected "agent" or "model")']);
    // The removed agent-only element shape has no kind and is refused too.
    expect(collaborationProblems({ strategy: 'parallel', participants: [{ agentId: 'x' }] })[0]).toMatch(
      /participants\[0\] has unknown kind "undefined"/,
    );
  });

  it('names an agent participant without an agentId', () => {
    expect(
      collaborationProblems({ strategy: 'race', participants: [{ kind: 'agent', agentId: 'ok' }, { kind: 'agent' }] }),
    ).toEqual(['collaboration.participants[1] is an agent participant without an agentId']);
  });

  it('names a model participant with neither providerId nor routing', () => {
    expect(collaborationProblems({ strategy: 'race', participants: [{ kind: 'model' }] })).toEqual([
      'collaboration.participants[0] is a model participant with neither a providerId nor a routing policy',
    ]);
  });

  it('names a model participant that has a model but nothing to call it through', () => {
    expect(
      collaborationProblems({ strategy: 'sequential', participants: [{ kind: 'model', model: 'gpt-x' }] }),
    ).toEqual(['collaboration.participants[0] names model "gpt-x" but no providerId or routing policy to call it through']);
  });

  it('applies the same checks to the judge', () => {
    expect(
      collaborationProblems({ strategy: 'parallel', participants: [], judge: { kind: 'model', model: 'm' } }),
    ).toEqual(['collaboration.judge names model "m" but no providerId or routing policy to call it through']);
    expect(collaborationProblems({ strategy: 'parallel', participants: [], judge: { kind: 'agent' } })).toEqual([
      'collaboration.judge is an agent participant without an agentId',
    ]);
  });
});

describe('buildCollaborationContext', () => {
  it('names models in the team list by role, else model, else "routed model"', () => {
    const lines = buildCollaborationContext(
      {
        strategy: 'parallel',
        participants: [
          { kind: 'agent', agentId: 'a1' },
          { kind: 'model', providerId: 'p', model: 'm1' },
          { kind: 'model', routing: {} },
          { kind: 'model', providerId: 'p', role: 'critic' },
        ],
        rules: { outputFormat: 'json', escalation: 'never' },
        sharedBrief: 'b',
      },
      'critic',
    );
    expect(lines).toEqual([
      'You are the "critic" in a parallel collaboration.',
      'Brief: b',
      'Rules: output format: json, escalation: never',
      'Team members: a1, m1, routed model, critic',
    ]);
  });
});

describe('AgentsService refuses an invalid collaboration at save time', () => {
  const service = () => {
    const agentRepository = {
      findOne: jest.fn(async () => ({ id: 'ag-1', organizationId: 'org-1', mode: 'autonomous', metadata: {} })),
      save: jest.fn(async (a: any) => a),
      create: jest.fn((a: any) => a),
      // Providers: p1 is org-wide, p-mine is user-1's private one,
      // p-theirs is another member's private one; anything else is missing.
      manager: {
        getRepository: (entity: unknown) => ({
          find: async () =>
            entity === LlmProvider
              ? [
                  { id: 'p1', visibility: 'org', ownerUserId: null },
                  { id: 'p-mine', visibility: 'private', ownerUserId: 'user-1' },
                  { id: 'p-theirs', visibility: 'private', ownerUserId: 'user-2' },
                ]
              : [],
        }),
      },
    };
    const organizationRepository = { findOne: jest.fn(async () => ({ id: 'org-1' })) };
    const svc = new AgentsService(
      agentRepository as any,
      {} as any,
      organizationRepository as any,
      {} as any,
      { log: jest.fn() } as any,
      { validatePipeline: jest.fn() } as any,
      { assertCanScopeToTeam: jest.fn() } as any,
      { assertReady: jest.fn() } as any,
    );
    return { svc, agentRepository };
  };

  it('create: 400 naming the bad participant, nothing saved', async () => {
    const { svc, agentRepository } = service();
    const err = await svc
      .createAgent(
        { name: 'x', mode: 'autonomous', collaboration: { strategy: 'parallel', participants: [{ kind: 'model', model: 'm' }] } as any },
        'org-1',
        'user-1',
      )
      .catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe(
      'Invalid collaboration: collaboration.participants[0] names model "m" but no providerId or routing policy to call it through',
    );
    expect(agentRepository.save).not.toHaveBeenCalled();
  });

  it('update: 400 on an unknown strategy, nothing saved', async () => {
    const { svc, agentRepository } = service();
    const err = await svc
      .updateAgent('ag-1', { collaboration: { strategy: 'swarm', participants: [] } as any }, 'org-1')
      .catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toMatch(/collaboration.strategy "swarm"/);
    expect(agentRepository.save).not.toHaveBeenCalled();
  });

  it('create: a model-only collaboration is saved', async () => {
    const { svc, agentRepository } = service();
    const collaboration = { strategy: 'race' as const, participants: [{ kind: 'model' as const, providerId: 'p1' }] };
    await svc.createAgent({ name: 'x', mode: 'autonomous', collaboration }, 'org-1', 'user-1').catch(() => undefined);
    expect(agentRepository.save).toHaveBeenCalledWith(expect.objectContaining({ collaboration }));
  });

  // A model participant is refused at save time when it names a provider
  // the saving user cannot use: another member's private one reads exactly
  // like one that does not exist (the run would refuse it either way).
  it('create: a model participant naming another member\'s private provider is refused like a missing one', async () => {
    const { svc, agentRepository } = service();
    const refusal = async (providerId: string) => {
      const collaboration = { strategy: 'race' as const, participants: [{ kind: 'model' as const, providerId }] };
      const err = await svc.createAgent({ name: 'x', mode: 'autonomous', collaboration }, 'org-1', 'user-1').catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      return String(err.message).replace(providerId, 'ID');
    };
    expect(await refusal('p-theirs')).toBe(await refusal('p-missing'));
    expect(agentRepository.save).not.toHaveBeenCalled();
  });

  it('create: the owner may name their own private provider', async () => {
    const { svc, agentRepository } = service();
    const collaboration = { strategy: 'race' as const, participants: [{ kind: 'model' as const, providerId: 'p-mine' }] };
    await svc.createAgent({ name: 'x', mode: 'autonomous', collaboration }, 'org-1', 'user-1');
    expect(agentRepository.save).toHaveBeenCalledWith(expect.objectContaining({ collaboration }));
  });
});

describe('step processor delegates a collaboration orchestrator', () => {
  const processorFor = (collaboration: any, parentRunId: string | null = null) => {
    const run: any = {
      id: 'run-1',
      organizationId: 'org-1',
      currentStep: 0,
      totalCost: 0,
      totalTokens: 0,
      status: AgentRunStatus.RUNNING,
      parentRunId,
      isDone: () => false,
      agent: { id: 'orch', collaboration },
    };
    const processCollaborationStep = jest.fn(async () => 'done');
    const s: any = {
      runRepository: { findOne: jest.fn(async () => run), find: jest.fn(async () => []) },
      organizationRepository: { findOne: jest.fn(async () => ({ id: 'org-1' })) },
      misc: {
        resolveLimits: jest.fn(async () => ({
          maxSteps: 50, maxCostCents: 1000, maxDurationMs: 1e9, maxTokens: 1e9, maxToolCalls: 1e9, maxRecursionDepth: 5,
        })),
      },
      collaboration: { processCollaborationStep },
      logger: { log: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
    };
    const processor = new AgentStepProcessor(s, {} as any, {} as any, {} as any);
    // Past the gate the processor would try to load tools; stop it there.
    jest.spyOn(processor as any, 'resolveTools').mockRejectedValue(new Error('past the gate'));
    return { processor, processCollaborationStep, run };
  };

  it('when the participants are all models', async () => {
    const { processor, processCollaborationStep, run } = processorFor({
      strategy: 'parallel',
      participants: [{ kind: 'model', providerId: 'p1' }, { kind: 'model', routing: {} }],
    });
    await expect(processor.processStep('run-1')).resolves.toBe('done');
    expect(processCollaborationStep).toHaveBeenCalledWith(run, run.agent);
  });

  it('not for a child run, and not with no participants', async () => {
    const child = processorFor({ strategy: 'parallel', participants: [{ kind: 'model', providerId: 'p1' }] }, 'parent');
    await child.processor.processStep('run-1').catch(() => undefined);
    expect(child.processCollaborationStep).not.toHaveBeenCalled();

    const empty = processorFor({ strategy: 'parallel', participants: [] });
    await empty.processor.processStep('run-1').catch(() => undefined);
    expect(empty.processCollaborationStep).not.toHaveBeenCalled();
  });
});
