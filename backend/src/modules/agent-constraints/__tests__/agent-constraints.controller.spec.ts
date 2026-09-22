import { HttpException, NotFoundException } from '@nestjs/common';

import { AgentConstraintsController } from '../agent-constraints.controller';
import { AgentConstraintsService } from '../agent-constraints.service';

/**
 * The path params of /agents/:agentId/constraints[/:id] have to mean something:
 * a constraint may only be created under an agent the caller's org owns, and may
 * only be toggled or deleted through the URL of the agent it belongs to.
 */
describe('AgentConstraintsController path-param binding', () => {
  const ORG = 'org-1';
  const OTHER_ORG = 'org-2';
  const AGENT_A = 'agent-a';
  const AGENT_B = 'agent-b';
  const FOREIGN_AGENT = 'agent-foreign';

  let store: any[];
  let agents: any[];
  let controller: AgentConstraintsController;

  const req = { user: { currentOrganizationId: ORG, sub: 'u1' } };

  const matches = (c: any, where: any) =>
    (where.id === undefined || c.id === where.id) &&
    (where.organizationId === undefined || c.organizationId === where.organizationId) &&
    (where.agentId === undefined || c.agentId === where.agentId) &&
    (where.rule === undefined || c.rule === where.rule) &&
    (where.active === undefined || c.active === where.active);

  beforeEach(() => {
    store = [];
    agents = [
      { id: AGENT_A, organizationId: ORG },
      { id: AGENT_B, organizationId: ORG },
      { id: FOREIGN_AGENT, organizationId: OTHER_ORG },
    ];
    let idc = 0;

    const constraintRepo: any = {
      find: jest.fn(({ where }: any) => Promise.resolve(store.filter((c) => matches(c, where)))),
      findOne: jest.fn(({ where }: any) => Promise.resolve(store.find((c) => matches(c, where)) || null)),
      create: jest.fn((x: any) => ({ ...x })),
      save: jest.fn((c: any) => {
        if (!c.id) c.id = `c-${++idc}`;
        const i = store.findIndex((x) => x.id === c.id);
        if (i >= 0) store[i] = c;
        else store.push(c);
        return Promise.resolve(c);
      }),
      delete: jest.fn((where: any) => {
        const before = store.length;
        store = store.filter((c) => !matches(c, where));
        return Promise.resolve({ affected: before - store.length });
      }),
    };

    const agentRepo: any = {
      count: jest.fn(({ where }: any) =>
        Promise.resolve(
          agents.filter((a) => a.id === where.id && a.organizationId === where.organizationId).length,
        ),
      ),
    };

    const service = new AgentConstraintsService(constraintRepo, { chat: jest.fn() } as any);
    controller = new AgentConstraintsController(service, agentRepo);
  });

  const seed = (agentId: string) => controller.add(agentId, { rule: `rule for ${agentId}` }, req);

  describe('create', () => {
    it('writes the constraint under the agent named in the path', async () => {
      const created: any = await seed(AGENT_A);
      expect(created.agentId).toBe(AGENT_A);
      expect(created.organizationId).toBe(ORG);
      expect(store).toHaveLength(1);
    });

    it('rejects an agentId belonging to another organization', async () => {
      await expect(seed(FOREIGN_AGENT)).rejects.toBeInstanceOf(HttpException);
      expect(store).toHaveLength(0);
    });

    it('rejects an agentId that does not exist at all', async () => {
      await expect(seed('agent-nope')).rejects.toBeInstanceOf(HttpException);
      expect(store).toHaveLength(0);
    });

    it('answers 404 AGENT_NOT_FOUND rather than a generic error', async () => {
      const err: any = await seed(FOREIGN_AGENT).catch((e) => e);
      expect(err.getStatus()).toBe(404);
      expect(err.getResponse()).toMatchObject({ error: 'AGENT_NOT_FOUND' });
    });
  });

  describe('update', () => {
    it('toggles a constraint through its own agent URL', async () => {
      const c: any = await seed(AGENT_A);
      const updated: any = await controller.setActive(AGENT_A, c.id, { active: false }, req);
      expect(updated.active).toBe(false);
    });

    it('refuses to toggle agent A constraint through agent B URL', async () => {
      const c: any = await seed(AGENT_A);
      await expect(controller.setActive(AGENT_B, c.id, { active: false }, req)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(store[0].active).toBe(true);
    });
  });

  describe('delete', () => {
    it('deletes a constraint through its own agent URL', async () => {
      const c: any = await seed(AGENT_A);
      await expect(controller.remove(AGENT_A, c.id, req)).resolves.toEqual({ success: true });
      expect(store).toHaveLength(0);
    });

    it('refuses to delete agent A constraint through agent B URL', async () => {
      const c: any = await seed(AGENT_A);
      await expect(controller.remove(AGENT_B, c.id, req)).rejects.toBeInstanceOf(NotFoundException);
      expect(store).toHaveLength(1);
    });
  });

  it('still lists only the named agent constraints', async () => {
    await seed(AGENT_A);
    await seed(AGENT_B);
    expect(await controller.list(AGENT_A, req)).toHaveLength(1);
  });
});
