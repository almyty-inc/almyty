import { HttpException, NotFoundException } from '@nestjs/common';
import { AgentRunsController } from '../agent-runs.controller';
import { fakeRepository } from '../../../test/fake-repository';

/**
 * The Route panel of a run. It asked the trace endpoint with the run's id,
 * and the endpoint only looked among workflow executions, so every
 * autonomous run answered "Run not found". An autonomous run is an agent
 * run whose calls are steps, each recording the routing it went through.
 */
const AGENT = '11111111-1111-4111-8111-111111111111';
const OTHER_AGENT = '22222222-2222-4222-8222-222222222222';
const RUN = '33333333-3333-4333-8333-333333333333';
const EXECUTION = '44444444-4444-4444-8444-444444444444';
const req = { user: { currentOrganizationId: 'org-1', id: 'u1' } };

function build() {
  const runs = [
    {
      id: RUN,
      organizationId: 'org-1',
      agentId: AGENT,
      metadata: {},
      steps: [
        {
          type: 'llm_call',
          role: { key: 'main', name: 'Main', purpose: 'main', kind: 'model' },
          output: { routing: { modelId: 'fast', vendorModelId: 'gpt-4o-mini', providerId: 'p1', rationale: 'cheapest' } },
          cost: 0.01,
          duration: 90,
          timestamp: '2026-09-30T10:00:00.000Z',
        },
        { type: 'tool_call', output: { result: 'ok' }, cost: 0, duration: 5, timestamp: '2026-09-30T10:00:01.000Z' },
      ],
    },
  ];
  const runtime = {
    getRun: jest.fn(async (id: string, organizationId: string, agentId?: string) => {
      const run = runs.find((r) => r.id === id && r.organizationId === organizationId && (!agentId || r.agentId === agentId));
      if (!run) throw new NotFoundException('Run not found');
      return run;
    }),
  };
  const executions = fakeRepository<any>({
    seed: [{ id: EXECUTION, organizationId: 'org-1', agentId: AGENT, metadata: {}, nodeResults: {} }],
  });
  return new AgentRunsController(runtime as any, executions as any);
}

describe('a run trace, for an autonomous run', () => {
  it("reads an autonomous run's routing from its steps", async () => {
    const res = await build().trace(AGENT, RUN, req);
    expect(res.data.executionId).toBe(RUN);
    const routed = res.data.steps.filter((s) => s.hops.length > 0);
    expect(routed).toHaveLength(1);
    expect(routed[0].nodeId).toBe('step 1 (Main)');
    expect(routed[0].hops.find((h) => h.layer === 'routing')!.chosen).toBe('gpt-4o-mini');
  });

  it("still reads a workflow execution's trace", async () => {
    const res = await build().trace(AGENT, EXECUTION, req);
    expect(res.data.executionId).toBe(EXECUTION);
  });

  it("does not resolve another agent's run through this agent's URL", async () => {
    await expect(build().trace(OTHER_AGENT, RUN, req)).rejects.toMatchObject({ status: 404 });
  });

  it('answers not found for an id that is neither', async () => {
    const err = await build().trace(AGENT, '55555555-5555-4555-8555-555555555555', req).catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(404);
  });
});
