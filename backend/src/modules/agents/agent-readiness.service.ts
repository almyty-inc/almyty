import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Agent } from '../../entities/agent.entity';
import { Organization } from '../../entities/organization.entity';
import { LlmProvider, LlmProviderStatus } from '../../entities/llm-provider.entity';
import { AgentRolesService, RoleUnresolvedError } from './agent-roles.service';
import { AgentValidationHelper } from './agent-validation.helper';
import { StrategyPipelineResolver } from './strategies/strategy-pipeline.resolver';
import { StrategyCompileError } from './strategies/strategy-compiler';
import { ModelRouterService } from '../model-catalog/routing/model-router.service';

/** Read-only configuration preflight. Never invokes a model or orchestrator. */
@Injectable()
export class AgentReadinessService {
  constructor(
    private readonly validation: AgentValidationHelper,
    private readonly strategies: StrategyPipelineResolver,
    private readonly roles: AgentRolesService,
    private readonly router: ModelRouterService,
    @InjectRepository(LlmProvider) private readonly providers: Repository<LlmProvider>,
    @InjectRepository(Organization) private readonly organizations: Repository<Organization>,
  ) {}

  async inspect(agent: Agent, userId?: string): Promise<{ ready: boolean; message?: string }> {
    try {
      await this.assertReady(agent, userId);
      return { ready: true };
    } catch (error) {
      // Infrastructure failures must not masquerade as configuration results.
      if (!(error instanceof BadRequestException)) throw error;
      return { ready: false, message: error.message };
    }
  }

  async assertReady(agent: Agent, userId?: string): Promise<void> {
    // Autonomous setup has different model-selection semantics.
    if (agent.mode === 'autonomous') return;
    const principal = userId ? { id: userId } : undefined;
    const execution = agent.settings?.execution;
    const strategyKey = execution?.orchestrator?.enabled
      ? execution.orchestrator.fallbackStrategyKey || 'single'
      : execution?.strategyKey;
    let pipeline = agent.pipeline;
    if (strategyKey) {
      if (!agent.id) throw new BadRequestException('Save this agent as a draft, then configure its model roles before activation.');
      try {
        pipeline = await this.strategies.compileStanding(Object.assign(new Agent(), agent, {
          settings: { ...agent.settings, execution: { ...execution, strategyKey } },
        }));
      } catch (error) {
        if (!(error instanceof StrategyCompileError)) throw error;
        throw new BadRequestException(`Not ready: ${error.message} Configure the strategy and roles on the Execution tab.`);
      }
    }
    this.validation.validatePipeline(pipeline, agent.id);
    const configs: Array<{ config: Record<string, any>; label: string }> = [];
    for (const node of pipeline.nodes) {
      const config = node.data || node.config || {};
      if (node.type === 'llm_call' || node.type === 'extract_context') {
        configs.push({ config, label: `Model node "${node.id}"` });
      } else if (node.type === 'verify') {
        for (const checker of config.checkers || []) configs.push({ config: checker, label: `Checker on "${node.id}"` });
      }
    }
    let filled: Awaited<ReturnType<AgentRolesService['resolveRoles']>> = [];
    if (configs.some(({ config }) => config.roleKey)) {
      if (!agent.id) throw new BadRequestException('Save this agent as a draft, then configure its model roles before activation.');
      try {
        filled = await this.roles.resolveRoles(agent.organizationId, agent.id, {}, principal);
      } catch (error) {
        if (!(error instanceof RoleUnresolvedError)) throw error;
        throw new BadRequestException(`Not ready: ${error.message}. Add an available model in Models and configure its role on the Execution tab.`);
      }
    }
    for (const { config, label } of configs) {
      if (config.roleKey) {
        const role = filled.find((r) => r.key === config.roleKey);
        if (!role) throw new BadRequestException(`Not ready: ${label} needs role "${config.roleKey}". Add it on the Execution tab.`);
        // A pin bypasses routing, but must still name a callable model here.
        if (role.via === 'pinned') {
          try {
            const { provider } = await this.router.providerForModelId(agent.organizationId, role.modelId, principal);
            if (provider.status !== LlmProviderStatus.ACTIVE) {
              throw new BadRequestException(`Not ready: the provider for role "${role.key}" is inactive.`);
            }
          } catch (error) {
            if (error instanceof BadRequestException) throw error;
            if (!/^Model .* (is not in this organization's catalog|has no callable provider)$/.test(error.message)) throw error;
            throw new BadRequestException(`Not ready: role "${role.key}" has no available model/provider. Check Models and its binding on the Execution tab.`);
          }
        }
      } else if (config.providerId) {
        const provider = await this.providers.findOne({
          where: { id: config.providerId, organizationId: agent.organizationId },
          select: { id: true, status: true },
        });
        if (!provider || provider.status !== LlmProviderStatus.ACTIVE) {
          throw new BadRequestException(`Not ready: ${label} needs an available provider in this organization. Edit that node's model configuration.`);
        }
      } else {
        const org = config.routing ? null : await this.organizations.findOne({
          where: { id: agent.organizationId }, select: { id: true, settings: true },
        });
        const policy = config.routing ?? org?.settings?.defaultRouting;
        if (!policy) throw new BadRequestException(`Not ready: ${label} needs a provider or routing policy. Configure it before activating.`);
        const plan = await this.router.plan(agent.organizationId, policy, principal);
        if (!plan.candidates.length) {
          throw new BadRequestException(`Not ready: ${label} has no available model matching its routing policy. Add or configure a model in Models.`);
        }
      }
    }
  }
}
