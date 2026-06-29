import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { PromotedSkill } from '../../entities/promoted-skill.entity';
import { AgentRun, AgentRunStatus } from '../../entities/agent-run.entity';
import { LlmProvidersService } from '../llm-providers/llm-providers.service';
import { PromotedSkillRenderer } from './promoted-skill-renderer';

export interface PromoteRunDto {
  name?: string;
  description?: string;
  /** Optional LLM distiller — its own provider/model. Omit for deterministic distillation. */
  distill?: { providerId: string; model?: string };
}

@Injectable()
export class PromotedSkillsService {
  private readonly logger = new Logger(PromotedSkillsService.name);

  constructor(
    @InjectRepository(PromotedSkill)
    private readonly skillRepository: Repository<PromotedSkill>,
    @InjectRepository(AgentRun)
    private readonly runRepository: Repository<AgentRun>,
    private readonly renderer: PromotedSkillRenderer,
    private readonly llmProvidersService: LlmProvidersService,
  ) {}

  /**
   * Promote a completed agent run into a reusable skill. Re-promoting against an
   * existing (org, slug) bumps the version in place rather than duplicating.
   */
  async promoteFromRun(
    runId: string,
    organizationId: string,
    userId: string | undefined,
    dto: PromoteRunDto = {},
  ): Promise<PromotedSkill> {
    const run = await this.runRepository.findOne({
      where: { id: runId, organizationId },
      relations: ['agent'],
    });
    if (!run) {
      throw new NotFoundException('Run not found');
    }
    if (run.status !== AgentRunStatus.COMPLETED) {
      throw new BadRequestException('Only completed runs can be promoted to a skill');
    }

    const agent = run.agent;
    const name = dto.name?.trim() || `${agent?.name || 'agent'} skill`;
    const slug = this.renderer.slugify(name);
    const description =
      dto.description?.trim() ||
      agent?.description ||
      `Skill promoted from a successful run of ${agent?.name || 'an agent'}`;

    const procedure = dto.distill?.providerId
      ? await this.distill(run, dto.distill, organizationId, userId)
      : this.renderer.deterministicProcedure(run, agent);

    const existing = await this.skillRepository.findOne({ where: { organizationId, slug } });
    const version = existing ? existing.version + 1 : 1;

    const content = this.renderer.renderSkillMd({
      slug,
      description,
      procedure,
      run,
      agent,
      version,
    });
    const frontmatter = {
      name: slug,
      description,
      metadata: { author: 'almyty', source: 'agent-run', runId: run.id, version: String(version) },
    };

    const skill = this.skillRepository.create({
      ...(existing ? { id: existing.id } : {}),
      organizationId,
      agentId: agent?.id,
      sourceRunId: run.id,
      name,
      slug,
      description,
      content,
      frontmatter,
      inputExample: run.input,
      version,
      createdBy: userId,
    });
    return this.skillRepository.save(skill);
  }

  list(organizationId: string): Promise<PromotedSkill[]> {
    return this.skillRepository.find({
      where: { organizationId },
      order: { createdAt: 'DESC' },
    });
  }

  async get(id: string, organizationId: string): Promise<PromotedSkill> {
    const skill = await this.skillRepository.findOne({ where: { id, organizationId } });
    if (!skill) {
      throw new NotFoundException('Promoted skill not found');
    }
    return skill;
  }

  async remove(id: string, organizationId: string): Promise<void> {
    const res = await this.skillRepository.delete({ id, organizationId });
    if (!res.affected) {
      throw new NotFoundException('Promoted skill not found');
    }
  }

  /** Skill list for protocol serving (MCP/REST) — name + rendered content. */
  async listForServing(organizationId: string): Promise<Array<{ name: string; content: string }>> {
    const skills = await this.skillRepository.find({
      where: { organizationId },
      select: ['slug', 'content'],
    });
    return skills.map((s) => ({ name: s.slug, content: s.content }));
  }

  /**
   * Distill the run into a reusable procedure with an LLM. Never throws — on a
   * provider error it falls back to the deterministic procedure so promotion
   * still succeeds.
   */
  private async distill(
    run: AgentRun,
    cfg: { providerId: string; model?: string },
    organizationId: string,
    userId?: string,
  ): Promise<string> {
    const transcript = (run.steps || [])
      .map((s) => {
        const out = typeof s.output === 'string' ? s.output : JSON.stringify(s.output ?? '');
        return `[${s.type}] ${out.slice(0, 400)}`;
      })
      .join('\n')
      .slice(0, 6000);

    const systemPrompt =
      `You distill a successful agent run into a concise, reusable procedure other ` +
      `agents can follow to solve similar tasks. Output numbered steps plus key ` +
      `pitfalls. No preamble.`;
    const userPrompt =
      `TASK:\n${typeof run.input === 'string' ? run.input : JSON.stringify(run.input ?? '')}\n\n` +
      `RUN TRANSCRIPT:\n${transcript}\n\n` +
      `FINAL OUTPUT:\n${typeof run.output === 'string' ? run.output : JSON.stringify(run.output ?? '')}`;

    try {
      const response = await this.llmProvidersService.chat(
        cfg.providerId,
        {
          messages: [
            { role: 'system' as any, content: systemPrompt },
            { role: 'user' as any, content: userPrompt },
          ],
          model: cfg.model,
          temperature: 0,
        },
        organizationId,
        userId,
      );
      return response?.message?.content?.trim() || this.renderer.deterministicProcedure(run, run.agent);
    } catch (err: any) {
      this.logger.warn(`Distiller failed for run ${run.id}; using deterministic procedure: ${err?.message}`);
      return this.renderer.deterministicProcedure(run, run.agent);
    }
  }
}
