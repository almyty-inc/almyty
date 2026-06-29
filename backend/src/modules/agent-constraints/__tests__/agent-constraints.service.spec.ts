import { NotFoundException } from '@nestjs/common';

import { AgentConstraintsService } from '../agent-constraints.service';

/**
 * Unit tests for AgentConstraintsService — the failure-memory store: CRUD,
 * active-rule listing for prompt injection, and learning a constraint from a
 * failed run (deterministic + LLM distiller, with dedup).
 */
describe('AgentConstraintsService', () => {
  let store: any[];
  let repo: any;
  let llm: { chat: jest.Mock };
  let service: AgentConstraintsService;

  beforeEach(() => {
    store = [];
    let idc = 0;
    repo = {
      find: jest.fn(({ where }: any) =>
        Promise.resolve(
          store.filter(
            (c) =>
              c.organizationId === where.organizationId &&
              (where.agentId ? c.agentId === where.agentId : true) &&
              (where.active === undefined ? true : c.active === where.active),
          ),
        ),
      ),
      findOne: jest.fn(({ where }: any) =>
        Promise.resolve(
          store.find(
            (c) =>
              (where.id ? c.id === where.id : true) &&
              c.organizationId === where.organizationId &&
              (where.agentId ? c.agentId === where.agentId : true) &&
              (where.rule ? c.rule === where.rule : true) &&
              (where.active === undefined ? true : c.active === where.active),
          ) || null,
        ),
      ),
      create: jest.fn((x: any) => ({ ...x })),
      save: jest.fn((c: any) => {
        if (!c.id) c.id = `c-${++idc}`;
        const i = store.findIndex((x) => x.id === c.id);
        if (i >= 0) store[i] = c;
        else store.push(c);
        return Promise.resolve(c);
      }),
      delete: jest.fn(({ id, organizationId }: any) => {
        const before = store.length;
        store = store.filter((c) => !(c.id === id && c.organizationId === organizationId));
        return Promise.resolve({ affected: before - store.length });
      }),
    };
    llm = { chat: jest.fn() };
    service = new AgentConstraintsService(repo, llm as any);
  });

  it('adds and lists active rules for prompt injection', async () => {
    await service.add('org-1', 'a1', 'Always cite sources', 'u1');
    const inactive = await service.add('org-1', 'a1', 'Old rule', 'u1');
    await service.setActive(inactive.id, 'org-1', false);

    expect(await service.listActiveRules('org-1', 'a1')).toEqual(['Always cite sources']);
    expect(await service.list('org-1', 'a1')).toHaveLength(2);
  });

  it('learns a deterministic constraint from a run error', async () => {
    const run: any = { id: 'run-1', organizationId: 'org-1', agentId: 'a1', error: 'rate limit exceeded', steps: [] };
    const c = await service.recordFromRun(run);
    expect(c?.rule).toContain('rate limit exceeded');
    expect(c?.origin).toBe('learned');
    expect(c?.sourceRunId).toBe('run-1');
  });

  it('learns from verify failures when there is no hard error', async () => {
    const run: any = {
      id: 'run-2', organizationId: 'org-1', agentId: 'a1', error: null,
      steps: [{ type: 'verify', output: { verdict: 'fail', failures: [{ rule: 'missing total' }] } }],
    };
    const c = await service.recordFromRun(run);
    expect(c?.rule).toContain('missing total');
  });

  it('does not duplicate an identical active constraint', async () => {
    const run: any = { id: 'run-3', organizationId: 'org-1', agentId: 'a1', error: 'boom', steps: [] };
    const first = await service.recordFromRun(run);
    const second = await service.recordFromRun(run);
    expect(second?.id).toBe(first?.id);
    expect(store).toHaveLength(1);
  });

  it('uses the LLM distiller when configured', async () => {
    llm.chat.mockResolvedValue({ message: { content: 'Do not call the API more than once per second.' } });
    const run: any = { id: 'run-4', organizationId: 'org-1', agentId: 'a1', error: 'rate limited', steps: [] };
    const c = await service.recordFromRun(run, { distill: { providerId: 'p1' } });
    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(c?.rule).toContain('once per second');
  });

  it('throws NotFound removing a missing constraint', async () => {
    await expect(service.remove('nope', 'org-1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
