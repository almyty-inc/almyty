import { Injectable, Inject, NotFoundException, BadRequestException, ConflictException, Logger, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Raw, Repository } from 'typeorm';

import { PromotedSkill } from '../../entities/promoted-skill.entity';
import { AgentRun, AgentRunStatus } from '../../entities/agent-run.entity';
import { isOthersPrivate } from '../../common/authorization/private-visibility';
import { notOthersPrivateAgent } from '../monitoring/private-rows';
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
    // forwardRef: the EE assembly's require order puts this file inside a
    // module cycle (llm-providers -> tool-executor -> runner -> mcp ->
    // promoted-skills); without it the class metadata reads undefined at
    // runtime and the whole app fails to boot (dev/staging CrashLoop).
    @Inject(forwardRef(() => LlmProvidersService))
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
      relations: { agent: true },
    });
    // A run of another member's private agent answers like a missing run.
    if (!run || (run.agent && isOthersPrivate(run.agent, userId ?? null))) {
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
    // (org, slug) is unique, so a name another member's private-derived
    // skill already holds cannot be taken -- and must not be re-promoted
    // in place, which would overwrite their skill and hand back its id.
    if (existing) {
      const visible = await this.skillRepository.findOne({
        where: { id: existing.id, organizationId, agentId: this.notOthersPrivateSource(userId) },
        select: { id: true },
      });
      if (!visible) {
        throw new ConflictException('A promoted skill with this name already exists; choose another name');
      }
    }
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

  list(organizationId: string, viewerId: string | null | undefined): Promise<PromotedSkill[]> {
    return this.skillRepository.find({
      where: { organizationId, agentId: this.notOthersPrivateSource(viewerId) },
      order: { createdAt: 'DESC' },
    });
  }

  async get(id: string, organizationId: string, viewerId: string | null | undefined): Promise<PromotedSkill> {
    const skill = await this.skillRepository.findOne({
      where: { id, organizationId, agentId: this.notOthersPrivateSource(viewerId) },
    });
    if (!skill) {
      throw new NotFoundException('Promoted skill not found');
    }
    return skill;
  }

  async remove(id: string, organizationId: string, viewerId: string | null | undefined): Promise<void> {
    // Resolve through get() so another member's private-derived skill is
    // "not found" here too, rather than deletable by id.
    await this.get(id, organizationId, viewerId);
    const res = await this.skillRepository.delete({ id, organizationId });
    if (!res.affected) {
      throw new NotFoundException('Promoted skill not found');
    }
  }

  /**
   * Skill list for protocol serving (MCP/REST) — name + rendered content.
   * A protocol call with no known user passes null, which leaves out every
   * skill promoted from a private agent.
   */
  async listForServing(
    organizationId: string,
    viewerId: string | null | undefined,
  ): Promise<Array<{ name: string; content: string }>> {
    const skills = await this.skillRepository.find({
      where: { organizationId, agentId: this.notOthersPrivateSource(viewerId) },
      select: { slug: true, content: true },
    });
    return skills.map((s) => ({ name: s.slug, content: s.content }));
  }

  /**
   * A promoted skill is derived from its source agent's run: its content
   * carries that agent's instructions, the tools it called and the run's
   * input and output. A skill promoted from another member's private agent
   * is therefore theirs alone -- not listed, readable, replayable or
   * deletable by anybody else, an org admin included. Checked against the
   * agent's current visibility, so making an agent private also withdraws
   * the skills promoted from it. A private tool or sub-agent can only be
   * wired into its owner's own private agent, so the agent's tier covers
   * them. No viewer (null) drops every private-derived skill.
   */
  private notOthersPrivateSource(viewerId: string | null | undefined) {
    return Raw(
      (column) => `(${column} IS NULL OR ${notOthersPrivateAgent(column)})`,
      { privateViewerId: viewerId ?? null },
    );
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
