import { Body, Controller, Get, HttpException, HttpStatus, Param, ParseUUIDPipe, Post, Put, Request, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IsBoolean, IsInt, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PrivateAgentByAgentIdGuard } from '../../common/authorization/private-resource.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { Agent } from '../../entities/agent.entity';
import { STRATEGY_SEEDS } from './strategies/strategy-seeds';
import { Strategy } from '../../entities/strategy.entity';
import { StrategyPipelineResolver } from './strategies/strategy-pipeline.resolver';
import { StrategyCompileError } from './strategies/strategy-compiler';

/**
 * How an agent runs: which shape it uses, and whether a model picks that
 * shape per request.
 *
 * This exists because the surface shipped without it. The Execution tab
 * let you choose a strategy and configure the orchestrator, both held in
 * component state with nothing behind them, so the choice was forgotten
 * the moment you left the tab. A picker that does not persist is worse
 * than no picker: it reads as configured when nothing was configured.
 *
 * Roles live on their own table because there are many per agent. There
 * is exactly one execution setting per agent, so it lives in the agent's
 * own settings rather than earning a table.
 */
export class OrchestratorSettingsDto {
  @IsBoolean() enabled: boolean;
  @IsString() roleKey: string;
  @IsInt() @Min(100) @Max(60_000) timeoutMs: number;
  @IsString() fallbackStrategyKey: string;
  @IsOptional() @IsString({ each: true }) allowedStrategyKeys?: string[];
}

export class UpdateExecutionDto {
  /** The shape this agent runs. Null clears it back to a plain pipeline. */
  @IsOptional() @IsString() strategyKey?: string | null;

  @IsOptional() @ValidateNested() @Type(() => OrchestratorSettingsDto) orchestrator?: OrchestratorSettingsDto;
}

export interface AgentExecutionSettings {
  strategyKey?: string | null;
  orchestrator?: OrchestratorSettingsDto;
}

const validation = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });

@ApiTags('Agents')
@ApiBearerAuth()
@Controller('agents/:agentId/execution')
@UseGuards(JwtAuthGuard, RolesGuard, PrivateAgentByAgentIdGuard)
export class AgentExecutionSettingsController {
  constructor(
    @InjectRepository(Agent) private readonly agents: Repository<Agent>,
    @InjectRepository(Strategy) private readonly strategies: Repository<Strategy>,
    private readonly resolver: StrategyPipelineResolver,
  ) {}

  private orgId(req: any): string {
    const organizationId = req.user?.currentOrganizationId;
    if (!organizationId) {
      throw new HttpException({ success: false, message: 'No organization found for user', error: 'NO_ORGANIZATION' }, HttpStatus.BAD_REQUEST);
    }
    return organizationId;
  }

  private async load(req: any, agentId: string): Promise<Agent> {
    const agent = await this.agents.findOne({ where: { id: agentId, organizationId: this.orgId(req) } });
    if (!agent) {
      throw new HttpException({ success: false, message: 'Agent not found', error: 'AGENT_NOT_FOUND' }, HttpStatus.NOT_FOUND);
    }
    return agent;
  }

  @Get()
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'The shape this agent runs, and its orchestrator settings' })
  async get(@Request() req: any, @Param('agentId', ParseUUIDPipe) agentId: string) {
    const agent = await this.load(req, agentId);
    const execution = (agent.settings?.execution ?? {}) as AgentExecutionSettings;
    return { success: true, data: execution };
  }

  @Put()
  @Roles('member', 'admin', 'owner')
  @UsePipes(validation)
  @ApiOperation({ summary: 'Choose the shape this agent runs' })
  async put(
    @Request() req: any,
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Body() body: UpdateExecutionDto,
  ) {
    const agent = await this.load(req, agentId);

    // A strategy here compiles to a pipeline graph, and only the pipeline
    // engine runs one. An autonomous agent's strategy is part of its models
    // (`agents.models`, set on its page and read by the loop every step;
    // docs/autonomous-models.md), so a choice made here would save and then
    // do nothing. Clearing is still allowed, so an agent switched from
    // workflow can shed a leftover choice.
    if (agent.mode === 'autonomous' && (body.strategyKey || body.orchestrator?.enabled)) {
      throw new HttpException(
        {
          success: false,
          message:
            "This agent is autonomous: choose how its models work together in its Models section. Strategies here compile to a workflow graph.",
          // `code`, not `error`: the global filter keeps a payload's code
          // and replaces its `error`, so only this reaches the client.
          code: 'STRATEGY_WORKFLOW_ONLY',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    // A strategy key that names nothing would save cleanly and then fail
    // at run time, long after the person who chose it has moved on.
    if (body.strategyKey) {
      const known =
        STRATEGY_SEEDS.some((s) => s.key === body.strategyKey) ||
        (await this.strategies.count({ where: { key: body.strategyKey, organizationId: agent.organizationId } })) > 0;
      if (!known) {
        throw new HttpException(
          { success: false, message: `No strategy named "${body.strategyKey}"`, error: 'STRATEGY_NOT_FOUND' },
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    const current = (agent.settings?.execution ?? {}) as AgentExecutionSettings;
    const execution: AgentExecutionSettings = {
      ...current,
      ...(body.strategyKey !== undefined ? { strategyKey: body.strategyKey } : {}),
      ...(body.orchestrator !== undefined ? { orchestrator: body.orchestrator } : {}),
    };

    agent.settings = { ...(agent.settings ?? {}), execution };
    await this.agents.save(agent);
    return { success: true, data: execution };
  }

  /**
   * Turn the chosen strategy into this agent's own graph, and stop
   * running the strategy.
   *
   * A strategy is a shape somebody else decided. Sooner or later you want
   * one step changed, and without this the only way out is to rebuild the
   * whole pipeline by hand from a description. The compiler already
   * produces a runnable graph -- the Execution tab had an "Eject to an
   * editable graph" button waiting on an endpoint that was never written,
   * so the button never rendered.
   *
   * Compiled nodes carry a roleKey, not a model, so ejecting does not
   * pin anything: routing still fills each role at run time.
   */
  @Post('eject')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: "Compile the chosen strategy into the agent's own editable pipeline" })
  async eject(@Request() req: any, @Param('agentId', ParseUUIDPipe) agentId: string) {
    const agent = await this.load(req, agentId);

    // Overwriting a graph somebody drew by hand is not recoverable from
    // this screen, so it is refused rather than done quietly.
    if (agent.pipeline?.nodes?.length) {
      throw new HttpException(
        {
          success: false,
          code: 'PIPELINE_NOT_EMPTY',
          message: 'This agent already has a graph. Ejecting would overwrite it.',
        },
        HttpStatus.CONFLICT,
      );
    }

    let pipeline;
    try {
      pipeline = await this.resolver.compileStanding(agent);
    } catch (err) {
      if (err instanceof StrategyCompileError) {
        throw new HttpException(
          { success: false, code: 'STRATEGY_NOT_COMPILABLE', message: err.message },
          HttpStatus.BAD_REQUEST,
        );
      }
      throw err;
    }

    const current = (agent.settings?.execution ?? {}) as AgentExecutionSettings;
    const execution: AgentExecutionSettings = { ...current, strategyKey: null };

    agent.pipeline = pipeline;
    agent.settings = { ...(agent.settings ?? {}), execution };
    await this.agents.save(agent);

    return { success: true, data: { pipeline, execution } };
  }
}
