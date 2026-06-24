import { NotFoundException, BadRequestException } from '@nestjs/common';

import { PromotedSkillsService } from '../promoted-skills.service';
import { PromotedSkillRenderer } from '../promoted-skill-renderer';
import { AgentRunStatus } from '../../../entities/agent-run.entity';

/**
 * Unit tests for PromotedSkillsService — promoting a completed run into a
 * reusable SKILL.md, re-version on re-promote, guards, and the optional LLM
 * distiller (with its deterministic fallback).
 */
describe('PromotedSkillsService', () => {
  let service: PromotedSkillsService;
  let skillStore: any[];
  let skillRepo: any;
  let runRepo: any;
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
    skillStore = [];
    let idc = 0;
    skillRepo = {
      find: jest.fn(({ where }: any) =>
        Promise.resolve(skillStore.filter((s) => s.organizationId === where.organizationId)),
      ),
      findOne: jest.fn(({ where }: any) =>
        Promise.resolve(
          skillStore.find(
            (s) =>
              (where.id ? s.id === where.id : true) &&
              (where.slug ? s.slug === where.slug : true) &&
              s.organizationId === where.organizationId,
          ) || null,
        ),
      ),
      create: jest.fn((x: any) => ({ ...x })),
      save: jest.fn((s: any) => {
        if (!s.id) s.id = `skill-${++idc}`;
        const i = skillStore.findIndex((x) => x.id === s.id);
        if (i >= 0) skillStore[i] = s;
        else skillStore.push(s);
        return Promise.resolve(s);
      }),
      delete: jest.fn(({ id, organizationId }: any) => {
        const before = skillStore.length;
        skillStore = skillStore.filter((s) => !(s.id === id && s.organizationId === organizationId));
        return Promise.resolve({ affected: before - skillStore.length });
      }),
    };
    runRepo = { findOne: jest.fn() };
    llm = { chat: jest.fn() };
    service = new PromotedSkillsService(skillRepo, runRepo, new PromotedSkillRenderer(), llm as any);
  });

  it('promotes a completed run into a SKILL.md (deterministic, no LLM)', async () => {
    runRepo.findOne.mockResolvedValue(completedRun());
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
  });

  it('rejects promoting a run that is not completed', async () => {
    runRepo.findOne.mockResolvedValue(completedRun({ status: AgentRunStatus.RUNNING }));
    await expect(service.promoteFromRun('run-1', 'org-1', 'u', {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('throws NotFound for a missing run', async () => {
    runRepo.findOne.mockResolvedValue(null);
    await expect(service.promoteFromRun('nope', 'org-1', 'u', {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('re-promotes in place and bumps the version', async () => {
    runRepo.findOne.mockResolvedValue(completedRun());
    skillStore.push({ id: 'existing-1', organizationId: 'org-1', slug: 'researcher-skill', version: 2 });

    const skill = await service.promoteFromRun('run-1', 'org-1', 'user-1', {});

    expect(skill.id).toBe('existing-1');
    expect(skill.version).toBe(3);
    expect(skillStore).toHaveLength(1);
  });

  it('uses the LLM distiller when a providerId is given', async () => {
    runRepo.findOne.mockResolvedValue(completedRun());
    llm.chat.mockResolvedValue({ message: { content: 'DISTILLED PROCEDURE' }, cost: 0.01, usage: { totalTokens: 9 } });

    const skill = await service.promoteFromRun('run-1', 'org-1', 'user-1', {
      distill: { providerId: 'p1' },
    });

    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(skill.content).toContain('DISTILLED PROCEDURE');
  });

  it('falls back to the deterministic procedure when the distiller throws', async () => {
    runRepo.findOne.mockResolvedValue(completedRun());
    llm.chat.mockRejectedValue(new Error('provider down'));

    const skill = await service.promoteFromRun('run-1', 'org-1', 'user-1', {
      distill: { providerId: 'p1' },
    });

    expect(skill.content).toContain('search'); // deterministic procedure mentions the tool
  });

  it('lists, gets, and removes promoted skills (org-scoped)', async () => {
    skillStore.push({ id: 's1', organizationId: 'org-1', slug: 'a' }, { id: 's2', organizationId: 'org-2', slug: 'b' });

    expect(await service.list('org-1')).toHaveLength(1);
    expect((await service.get('s1', 'org-1')).id).toBe('s1');
    await expect(service.get('s2', 'org-1')).rejects.toBeInstanceOf(NotFoundException);

    await service.remove('s1', 'org-1');
    expect(skillStore.find((s) => s.id === 's1')).toBeUndefined();
    await expect(service.remove('missing', 'org-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('exposes skills for protocol serving as name + content', async () => {
    skillStore.push({ id: 's1', organizationId: 'org-1', slug: 'my-skill', content: 'SKILL.md body' });
    const served = await service.listForServing('org-1');
    expect(served).toEqual([{ name: 'my-skill', content: 'SKILL.md body' }]);
  });
});
