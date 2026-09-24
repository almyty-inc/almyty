import { NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';

import { PromotedSkillsService } from '../promoted-skills.service';
import { PromotedSkillRenderer } from '../promoted-skill-renderer';
import { AgentRunStatus } from '../../../entities/agent-run.entity';
import { fakeRepository, type FakeRepository } from '../../../test/fake-repository';

/**
 * Unit tests for PromotedSkillsService — promoting a completed run into a
 * reusable SKILL.md, re-version on re-promote, guards, and the optional LLM
 * distiller (with its deterministic fallback).
 *
 * Skills, runs and the source agents are truthful tables. The service
 * filters skills with a Raw SQL predicate on agentId (the private-agent
 * rule); the fake evaluates that exact SQL against the agents table and
 * throws for any SQL it does not recognise, so a changed or dropped
 * predicate shows up here rather than only against Postgres (where the
 * integration spec also runs it).
 */
describe('PromotedSkillsService', () => {
  let service: PromotedSkillsService;
  let skills: FakeRepository<any>;
  let runs: FakeRepository<any>;
  let agents: FakeRepository<any>;
  let llm: { chat: jest.Mock };

  const completedRun = (over: any = {}) => ({
    id: 'run-1',
    organizationId: 'org-1',
    status: AgentRunStatus.COMPLETED,
    input: 'do the thing',
    output: 'the final answer',
    steps: [{ type: 'tool_call', input: { tool: 'search' } }],
    agent: { id: 'a1', name: 'Researcher', instructions: 'be thorough', description: 'researches things' },
    ...over,
  });

  beforeEach(() => {
    agents = fakeRepository<any>([]);
    skills = fakeRepository<any>({ tables: { agents }, idPrefix: 'skill' });
    runs = fakeRepository<any>([]);
    llm = { chat: jest.fn() };
    service = new PromotedSkillsService(skills as any, runs as any, new PromotedSkillRenderer(), llm as any);
  });

  it('promotes a completed run into a SKILL.md (deterministic, no LLM)', async () => {
    runs.seed(completedRun());
    const skill = await service.promoteFromRun('run-1', 'org-1', 'user-1', {});

    expect(skill.slug).toBe('researcher-skill');
    expect(skill.version).toBe(1);
    expect(skill.sourceRunId).toBe('run-1');
    expect(skill.agentId).toBe('a1');
    expect(skill.content).toContain('name: researcher-skill');
    expect(skill.content).toContain('## Procedure');
    expect(skill.content).toContain('search'); // the tool the run used
    expect(skill.content).toContain('the final answer'); // reference result
    expect(llm.chat).not.toHaveBeenCalled();
    expect(skills.row(skill.id)).toMatchObject({ organizationId: 'org-1', slug: 'researcher-skill', version: 1 });
  });

  it('rejects promoting a run that is not completed', async () => {
    runs.seed(completedRun({ status: AgentRunStatus.RUNNING }));
    await expect(service.promoteFromRun('run-1', 'org-1', 'u', {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(skills.rows()).toHaveLength(0);
  });

  it('throws NotFound for a missing run', async () => {
    await expect(service.promoteFromRun('nope', 'org-1', 'u', {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('refuses to promote a run that belongs to another organization', async () => {
    runs.seed(completedRun({ organizationId: 'org-2' }));
    await expect(service.promoteFromRun('run-1', 'org-1', 'u', {})).rejects.toBeInstanceOf(NotFoundException);
    expect(skills.rows()).toHaveLength(0);
  });

  it('re-promotes in place and bumps the version', async () => {
    runs.seed(completedRun());
    skills.seed({ id: 'existing-1', organizationId: 'org-1', slug: 'researcher-skill', version: 2, agentId: 'a1' });

    const skill = await service.promoteFromRun('run-1', 'org-1', 'user-1', {});

    expect(skill.id).toBe('existing-1');
    expect(skill.version).toBe(3);
    expect(skills.rows()).toHaveLength(1);
    expect(skills.row('existing-1')).toMatchObject({ version: 3, sourceRunId: 'run-1' });
  });

  it("does not re-promote over another organization's skill of the same slug", async () => {
    runs.seed(completedRun());
    skills.seed({ id: 'theirs', organizationId: 'org-2', slug: 'researcher-skill', version: 7, content: 'their body' });

    const skill = await service.promoteFromRun('run-1', 'org-1', 'user-1', {});

    expect(skill.id).not.toBe('theirs');
    expect(skill.version).toBe(1);
    expect(skills.row('theirs')).toMatchObject({ organizationId: 'org-2', version: 7, content: 'their body' });
  });

  it('uses the LLM distiller when a providerId is given', async () => {
    runs.seed(completedRun());
    llm.chat.mockResolvedValue({ message: { content: 'DISTILLED PROCEDURE' }, cost: 0.01, usage: { totalTokens: 9 } });

    const skill = await service.promoteFromRun('run-1', 'org-1', 'user-1', {
      distill: { providerId: 'p1' },
    });

    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(skill.content).toContain('DISTILLED PROCEDURE');
  });

  it('falls back to the deterministic procedure when the distiller throws', async () => {
    runs.seed(completedRun());
    llm.chat.mockRejectedValue(new Error('provider down'));

    const skill = await service.promoteFromRun('run-1', 'org-1', 'user-1', {
      distill: { providerId: 'p1' },
    });

    expect(skill.content).toContain('search'); // deterministic procedure mentions the tool
  });

  it('lists, gets, and removes promoted skills (org-scoped)', async () => {
    skills.seed({ id: 's1', organizationId: 'org-1', slug: 'a' });
    skills.seed({ id: 's2', organizationId: 'org-2', slug: 'b' });

    expect((await service.list('org-1', 'user-1')).map((s) => s.id)).toEqual(['s1']);
    expect((await service.get('s1', 'org-1', 'user-1')).id).toBe('s1');
    await expect(service.get('s2', 'org-1', 'user-1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.remove('s2', 'org-1', 'user-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(skills.row('s2')).toBeDefined();

    await service.remove('s1', 'org-1', 'user-1');
    expect(skills.row('s1')).toBeUndefined();
    await expect(service.remove('missing', 'org-1', 'user-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('exposes skills for protocol serving as name + content, org-scoped', async () => {
    skills.seed({ id: 's1', organizationId: 'org-1', slug: 'my-skill', content: 'SKILL.md body' });
    skills.seed({ id: 's2', organizationId: 'org-2', slug: 'their-skill', content: 'theirs' });
    const served = await service.listForServing('org-1', 'user-1');
    expect(served).toEqual([{ name: 'my-skill', content: 'SKILL.md body' }]);
  });

  describe('skills promoted from a private agent', () => {
    // 'a-private' is private to owner-1, 'a-org' is org-wide.
    beforeEach(() => {
      agents.seed({ id: 'a-private', organizationId: 'org-1', visibility: 'private', createdBy: 'owner-1' });
      agents.seed({ id: 'a-org', organizationId: 'org-1', visibility: 'org', createdBy: 'owner-1' });
      skills.seed({ id: 'mine', organizationId: 'org-1', slug: 'mine', version: 1, content: 'private body', agentId: 'a-private' });
      skills.seed({ id: 'shared', organizationId: 'org-1', slug: 'shared', content: 'org body', agentId: 'a-org' });
      skills.seed({ id: 'orphan', organizationId: 'org-1', slug: 'orphan', content: 'no agent', agentId: null });
    });

    it('are listed and served to their owner', async () => {
      expect((await service.list('org-1', 'owner-1')).map((s) => s.id).sort()).toEqual(['mine', 'orphan', 'shared']);
      expect((await service.listForServing('org-1', 'owner-1')).map((s) => s.name).sort()).toEqual(['mine', 'orphan', 'shared']);
      expect((await service.get('mine', 'org-1', 'owner-1')).content).toBe('private body');
    });

    it('are invisible to anyone else (admins included): list, serve, get, remove', async () => {
      expect((await service.list('org-1', 'admin-2')).map((s) => s.id).sort()).toEqual(['orphan', 'shared']);
      expect((await service.listForServing('org-1', 'admin-2')).map((s) => s.name).sort()).toEqual(['orphan', 'shared']);
      await expect(service.get('mine', 'org-1', 'admin-2')).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.remove('mine', 'org-1', 'admin-2')).rejects.toBeInstanceOf(NotFoundException);
      expect(skills.row('mine')).toBeDefined();
    });

    it('fail closed with no known viewer', async () => {
      expect((await service.listForServing('org-1', null)).map((s) => s.name).sort()).toEqual(['orphan', 'shared']);
      await expect(service.get('mine', 'org-1', undefined)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('are withdrawn when the source agent goes private, and come back when it does not', async () => {
      await agents.update({ id: 'a-org' }, { visibility: 'private' });
      expect((await service.list('org-1', 'admin-2')).map((s) => s.id)).toEqual(['orphan']);
      await agents.update({ id: 'a-org' }, { visibility: 'org' });
      expect((await service.list('org-1', 'admin-2')).map((s) => s.id).sort()).toEqual(['orphan', 'shared']);
    });

    it("refuse promoting a run of another member's private agent as not found", async () => {
      runs.seed(completedRun({ agent: { id: 'a-private', name: 'Secret', visibility: 'private', createdBy: 'owner-1' } }));
      await expect(service.promoteFromRun('run-1', 'org-1', 'admin-2', {})).rejects.toBeInstanceOf(NotFoundException);
      expect(skills.rows()).toHaveLength(3);
    });

    it("refuse re-promoting over another member's private-derived skill", async () => {
      runs.seed(completedRun({ agent: { id: 'a-org', name: 'mine', visibility: 'org' } }));
      await expect(
        service.promoteFromRun('run-1', 'org-1', 'admin-2', { name: 'mine' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(skills.row('mine')).toMatchObject({ content: 'private body', agentId: 'a-private' });
    });

    it('the owner may re-promote over their own private-derived skill', async () => {
      runs.seed(completedRun({ agent: { id: 'a-private', name: 'mine', visibility: 'private', createdBy: 'owner-1' } }));
      const skill = await service.promoteFromRun('run-1', 'org-1', 'owner-1', { name: 'mine' });
      expect(skill.id).toBe('mine');
      expect(skills.row('mine')?.version).toBe(2);
    });
  });
});
