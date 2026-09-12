import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { Agent, AgentPipeline } from '../../../entities/agent.entity';
import { AgentRole } from '../../../entities/agent-role.entity';
import { Strategy } from '../../../entities/strategy.entity';
import { STRATEGY_SEEDS } from './strategy-seeds';
import { compileStrategy, StrategyCompileError } from './strategy-compiler';
import { OrchestratorService } from './orchestrator.service';

/**
 * Turn the strategy an agent has chosen into the pipeline the engine runs.
 *
 * This is the link that was missing. A strategy could be described,
 * listed, picked in the UI and saved on the agent, and the engine still
 * ran `agent.pipeline` — so choosing a shape changed nothing at all at
 * run time. The compiler had no caller outside its own tests.
 *
 * Compiled nodes name a ROLE, never a model, so which model answers is
 * still L4's decision at execution time. See docs/design/layers.md, L5.
 */
export interface CompiledStrategy {
  pipeline: AgentPipeline;
  strategyKey: string;
  /** Set when a model chose the shape rather than the agent's setting. */
  chosenBy?: 'orchestrator' | 'fallback';
  /** Why the fallback was used, when it was. */
  fallbackReason?: string;
}

@Injectable()
export class StrategyPipelineResolver {
  private readonly logger = new Logger(StrategyPipelineResolver.name);

  constructor(
    @InjectRepository(Strategy) private readonly strategies: Repository<Strategy>,
    @InjectRepository(AgentRole) private readonly roles: Repository<AgentRole>,
    // @Optional() so an install without L6 still runs the agent's own
    // chosen shape, which is the common case.
    @Optional() private readonly orchestrator?: OrchestratorService,
  ) {}

  /** The chosen shape compiled, or null when the agent runs its own graph. */
  async pipelineFor(agent: Agent, request = ''): Promise<CompiledStrategy | null> {
    // A model picking the shape per request overrides the standing
    // choice, which is the whole point of switching it on.
    const choice = (await this.orchestrator?.choose(agent, request)) ?? null;
    const strategyKey = choice?.strategyKey ?? ((agent.settings as any)?.execution?.strategyKey as string | undefined | null);
    if (!strategyKey) return null;

    const shape = await this.find(strategyKey, agent.organizationId);
    if (!shape) {
      // Named a strategy that no longer exists. Refusing the run says so
      // once, where a silent fall back to the raw graph would quietly run
      // something the person did not ask for.
      throw new StrategyCompileError(
        choice
          ? `The orchestrator chose "${strategyKey}", which no longer exists.`
          : `This agent is set to run "${strategyKey}", which no longer exists. Pick another strategy on the Execution tab.`,
      );
    }

    const roles = await this.roles.find({ where: { organizationId: agent.organizationId, agentId: agent.id } });
    // A role fills the slot of the same name. Roles are named after the
    // slots the shapes ask for, so the mapping is identity — the indirection
    // exists so a future agent can bind its own names without the compiler
    // caring.
    const bindings = Object.fromEntries(roles.map((r) => [r.key, r.key]));

    return {
      pipeline: compileStrategy(shape, bindings),
      strategyKey,
      ...(choice ? { chosenBy: choice.via, fallbackReason: choice.fallbackReason } : {}),
    };
  }

  private async find(key: string, organizationId: string): Promise<Pick<Strategy, 'key' | 'roleSlots' | 'shape'> | null> {
    // An organization's own row wins over the built-in of the same key,
    // which is how you customise one.
    const rows = await this.strategies.find({ where: [{ key, organizationId }, { key, organizationId: IsNull() }] });
    const own = rows.find((r) => r.organizationId === organizationId);
    if (own) return own;
    if (rows.length) return rows[0];
    return STRATEGY_SEEDS.find((s) => s.key === key) ?? null;
  }
}
