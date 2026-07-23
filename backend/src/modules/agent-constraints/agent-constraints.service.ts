import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AgentConstraint } from '../../entities/agent-constraint.entity';
import { AgentRun } from '../../entities/agent-run.entity';
import { LlmProvidersService } from '../llm-providers/llm-providers.service';

export interface ConstraintLearnConfig {
  distill?: { providerId: string; model?: string };
}

@Injectable()
export class AgentConstraintsService {
  private readonly logger = new Logger(AgentConstraintsService.name);

  constructor(
    @InjectRepository(AgentConstraint)
    private readonly repo: Repository<AgentConstraint>,
    private readonly llmProvidersService: LlmProvidersService,
  ) {}

  list(organizationId: string, agentId: string): Promise<AgentConstraint[]> {
    return this.repo.find({ where: { organizationId, agentId }, order: { createdAt: 'DESC' } });
  }

  /** Active rule texts for prompt injection. */
  async listActiveRules(organizationId: string, agentId: string): Promise<string[]> {
    const rows = await this.repo.find({
      where: { organizationId, agentId, active: true },
      select: { rule: true },
      order: { createdAt: 'ASC' },
    });
    return rows.map((r) => r.rule);
  }

  async add(
    organizationId: string,
    agentId: string,
    rule: string,
    userId?: string,
    origin: 'learned' | 'manual' = 'manual',
    sourceRunId?: string,
  ): Promise<AgentConstraint> {
    const c = this.repo.create({
      organizationId,
      agentId,
      rule: rule.trim().slice(0, 1000),
      origin,
      sourceRunId,
      active: true,
      createdBy: userId,
    });
    return this.repo.save(c);
  }

  async setActive(id: string, organizationId: string, active: boolean): Promise<AgentConstraint> {
    const c = await this.repo.findOne({ where: { id, organizationId } });
    if (!c) throw new NotFoundException('Constraint not found');
    c.active = active;
    return this.repo.save(c);
  }

  async remove(id: string, organizationId: string): Promise<void> {
    const res = await this.repo.delete({ id, organizationId });
    if (!res.affected) throw new NotFoundException('Constraint not found');
  }

  /**
   * Learn a constraint from a failed run. Distills the failure (deterministically
   * from the error / verify failures, or via an optional LLM) into a "do not"
   * rule and stores it — unless an identical active rule already exists. Never
   * throws: failure-learning must not break the run that triggered it.
   */
  async recordFromRun(
    run: AgentRun,
    cfg: ConstraintLearnConfig = {},
  ): Promise<AgentConstraint | null> {
    try {
      const rule = cfg.distill?.providerId
        ? await this.distill(run, cfg.distill)
        : this.deterministicRule(run);
      if (!rule) return null;

      const existing = await this.repo.findOne({
        where: { organizationId: run.organizationId, agentId: run.agentId, rule, active: true },
      });
      if (existing) return existing;

      return this.add(run.organizationId, run.agentId, rule, undefined, 'learned', run.id);
    } catch (err: any) {
      this.logger.warn(`Failed to learn constraint from run ${run.id}: ${err?.message}`);
      return null;
    }
  }

  /** Deterministic rule from the run's error or its verify failures. */
  private deterministicRule(run: AgentRun): string | null {
    if (run.error) {
      return `Avoid the failure encountered previously: ${run.error.trim()}`.slice(0, 1000);
    }
    const verifyFailures = (run.steps || [])
      .filter((s) => s.type === 'verify' && s.output?.verdict === 'fail')
      .flatMap((s) => (Array.isArray(s.output?.failures) ? s.output.failures : []))
      .map((f: any) => f?.rule)
      .filter(Boolean);
    if (verifyFailures.length > 0) {
      return `Do not repeat these issues a verifier flagged: ${[...new Set(verifyFailures)].join('; ')}`.slice(0, 1000);
    }
    return null;
  }

  private async distill(run: AgentRun, cfg: { providerId: string; model?: string }): Promise<string | null> {
    const systemPrompt =
      `Turn the failure below into ONE short imperative constraint (a "do" or "do not" rule) ` +
      `that would prevent the same mistake next time. One sentence, no preamble.`;
    const userPrompt =
      `TASK: ${typeof run.input === 'string' ? run.input : JSON.stringify(run.input ?? '')}\n` +
      `ERROR: ${run.error || '(no hard error; the result was judged inadequate)'}\n` +
      `LAST STEPS: ${JSON.stringify((run.steps || []).slice(-4)).slice(0, 2000)}`;

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
      run.organizationId,
    );
    return response?.message?.content?.trim()?.slice(0, 1000) || this.deterministicRule(run);
  }
}
