import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { Agent } from '../../../entities/agent.entity';
import { MessageRole } from '../../../entities/message.entity';
import { Strategy } from '../../../entities/strategy.entity';
import { AgentRolesService } from '../agent-roles.service';
import { ModelRouterService } from '../../model-catalog/routing/model-router.service';
import { LlmProvidersService } from '../../llm-providers/llm-providers.service';
import { STRATEGY_SEEDS } from './strategy-seeds';
import {
  fallbackChoice,
  orchestratorPrompt,
  readOrchestratorAnswer,
  ORCHESTRATOR_DEFAULTS,
  type OrchestratorChoice,
  type OrchestratorConfig,
} from './orchestrator';

/**
 * Ask a small model which shape to use for this request.
 *
 * The parts of this existed and were tested -- the prompt, the answer
 * reader, the fallback -- and nothing called them, so switching the
 * orchestrator on changed nothing at run time. This is the caller.
 *
 * Every failure lands in the same place on purpose. It times out, it
 * answers rubbish, it names a strategy nobody has, it cannot reach a
 * model at all: each one falls back to the configured strategy with a
 * reason attached. A run is never left without a shape, and a person can
 * always find out why they got the fallback rather than a choice.
 *
 * See docs/design/layers.md, L6.
 */
@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger(OrchestratorService.name);

  constructor(
    @InjectRepository(Strategy) private readonly strategies: Repository<Strategy>,
    private readonly roles: AgentRolesService,
    @Optional() private readonly router?: ModelRouterService,
    @Optional() private readonly llm?: LlmProvidersService,
  ) {}

  /** The shape to run, or null when this agent does not orchestrate. */
  async choose(agent: Agent, request: string): Promise<OrchestratorChoice | null> {
    const config = this.configFor(agent);
    if (!config?.enabled) return null;

    // Two lists, deliberately. The prompt offers only what is allowed, so
    // the model is not invited to pick something it cannot have. The
    // validation sees everything, so a model that picks a real strategy
    // outside the allowed list is told THAT, rather than being told the
    // organization does not have it -- which would be untrue and would
    // send whoever reads the run looking in the wrong place.
    const all = await this.available(agent.organizationId);
    const allowed = config.allowedStrategyKeys;
    const offered = allowed?.length ? all.filter((s) => allowed.includes(s.key)) : all;
    if (offered.length === 0) {
      return fallbackChoice(config, 'this organization has no strategies to choose from');
    }

    try {
      const answer = await this.ask(agent, config, offered, request);
      const read = readOrchestratorAnswer(answer, all, config.allowedStrategyKeys);
      if (read.ok === false) return fallbackChoice(config, read.reason);
      return { strategyKey: read.strategyKey, roleBindings: read.roleBindings, reasoning: read.reasoning, via: 'orchestrator' };
    } catch (err: any) {
      // Including the timeout. The orchestrator is an optimisation, so
      // its failure costs a choice and never the run.
      this.logger.warn(`Orchestrator fell back for agent ${agent.id}: ${err?.message ?? err}`);
      return fallbackChoice(config, err?.message ?? 'the orchestrator could not be reached');
    }
  }

  private configFor(agent: Agent): OrchestratorConfig | null {
    const stored = (agent.settings as any)?.execution?.orchestrator as Partial<OrchestratorConfig> | undefined;
    if (!stored) return null;
    return { ...ORCHESTRATOR_DEFAULTS, ...stored };
  }

  /** Every strategy this organization can see, built-ins included. */
  private async available(organizationId: string) {
    const stored = await this.strategies.find({ where: [{ organizationId }, { organizationId: IsNull() }] });
    const byKey = new Map<string, Pick<Strategy, 'key' | 'displayName' | 'roleSlots' | 'shape'>>();
    for (const seed of STRATEGY_SEEDS) byKey.set(seed.key, seed);
    for (const row of stored) byKey.set(row.key, row);

    return [...byKey.values()];
  }

  private async ask(
    agent: Agent,
    config: OrchestratorConfig,
    available: Array<Pick<Strategy, 'key' | 'displayName' | 'roleSlots' | 'shape'>>,
    request: string,
  ): Promise<string> {
    if (!this.router || !this.llm) throw new Error('no model is wired to decide with');

    const resolved = await this.roles.resolveRoles(agent.organizationId, agent.id);
    const decider = resolved.find((r) => r.key === config.roleKey);
    if (!decider) {
      throw new Error(`this agent has no role called "${config.roleKey}" to decide with`);
    }

    const { provider } = await this.router.providerForModelId(agent.organizationId, decider.modelId);
    const roleKeys = resolved.map((r) => r.key);

    const call = this.llm.chat(
      provider.id,
      {
        temperature: 0,
        maxTokens: 400,
        messages: [{ role: MessageRole.USER, content: orchestratorPrompt(request, available, roleKeys) }],
      } as any,
      agent.organizationId,
    );

    // A decision that takes longer than the work it is deciding about is
    // not worth waiting for, so the budget is a deadline rather than a
    // suggestion.
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`it did not answer within ${config.timeoutMs}ms`)), config.timeoutMs);
    });

    try {
      const response = (await Promise.race([call, deadline])) as any;
      return response?.message?.content ?? '';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
