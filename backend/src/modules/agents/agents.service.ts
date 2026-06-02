import { AgentValidationHelper } from './agent-validation.helper';
import { AgentTemplate, getAgentTemplates } from './agent-templates';
import { EstimatedCost, estimateAgentCost } from './agent-cost-estimator';
import { Injectable, Logger, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Agent, AgentStatus, AgentPipeline, AgentPipelineNode, AgentPipelineEdge } from '../../entities/agent.entity';
import { AgentExecution } from '../../entities/agent-execution.entity';
import { Organization } from '../../entities/organization.entity';
import { User } from '../../entities/user.entity';
import { AgentAuditService } from './agent-audit.service';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';

export interface AgentSearchFilters {
  search?: string;
  status?: AgentStatus;
  organizationId: string;
  // Required so getAgents can apply the team-scope visibility filter
  // via AccessPolicyService.applyListFilter. Without this, a
  // team_member sees every team-scoped agent in the org instead of
  // just the agents on their own teams.
  caller: { id: string };
  page?: number;
  limit?: number;
  sortBy?: 'name' | 'createdAt' | 'updatedAt' | 'totalExecutions';
  sortOrder?: 'ASC' | 'DESC';
}

export interface CreateAgentInput {
  name: string;
  description?: string;
  status?: AgentStatus;
  version?: string;
  mode?: 'workflow' | 'autonomous';
  pipeline?: AgentPipeline;
  instructions?: string;
  personality?: string;
  heartbeat?: { enabled: boolean; intervalMinutes: number; prompt: string };
  toolIds?: string[];
  modelConfig?: { providerId?: string; model?: string; temperature?: number; maxTokens?: number };
  memoryConfig?: { enabled?: boolean; autoSave?: boolean; scopes?: string[] };
  agentConfig?: { canCallAgents?: boolean; canCreateAgents?: boolean };
  collaboration?: { strategy: string; agents: { agentId: string; role?: string }[]; judgeAgentId?: string; maxRounds?: number } | null;
  variables?: Record<string, any>;
  settings?: Record<string, any>;
  metadata?: Record<string, any>;
  webhookUrl?: string;
  // Team-scoping fields from the dashboard's VisibilityField.
  visibility?: 'org' | 'team';
  teamId?: string | null;
}
export interface UpdateAgentInput {
  name?: string;
  description?: string;
  status?: AgentStatus;
  version?: string;
  mode?: 'workflow' | 'autonomous';
  pipeline?: AgentPipeline;
  instructions?: string;
  personality?: string;
  heartbeat?: { enabled: boolean; intervalMinutes: number; prompt: string };
  toolIds?: string[];
  modelConfig?: { providerId?: string; model?: string; temperature?: number; maxTokens?: number };
  memoryConfig?: { enabled?: boolean; autoSave?: boolean; scopes?: string[] };
  agentConfig?: { canCallAgents?: boolean; canCreateAgents?: boolean };
  collaboration?: { strategy: string; agents: { agentId: string; role?: string }[]; judgeAgentId?: string; maxRounds?: number } | null;
  variables?: Record<string, any>;
  settings?: Record<string, any>;
  metadata?: Record<string, any>;
  webhookUrl?: string;
  // Team-scoping fields from the dashboard's VisibilityField.
  visibility?: 'org' | 'team';
  teamId?: string | null;
}

export { AgentTemplate } from './agent-templates';

export interface AgentVersionSnapshot {
  version: string;
  pipeline: AgentPipeline;
  savedAt: string;
  changelog: string;
}

@Injectable()
export class AgentsService {
  private readonly logger = new Logger(AgentsService.name);

  constructor(
    @InjectRepository(Agent)
    private agentRepository: Repository<Agent>,
    @InjectRepository(AgentExecution)
    private agentExecutionRepository: Repository<AgentExecution>,
    @InjectRepository(Organization)
    private organizationRepository: Repository<Organization>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private auditService: AgentAuditService,
    private readonly validation: AgentValidationHelper,
    private readonly accessPolicy: AccessPolicyService,
  ) {}

  async createAgent(
    createDto: CreateAgentInput,
    organizationId: string,
    userId: string,
  ): Promise<Agent> {
    try {
      this.logger.log(`[CREATE_AGENT] Creating agent '${createDto.name}' for org=${organizationId}, user=${userId}`);

      // Verify organization
      const organization = await this.organizationRepository.findOne({
        where: { id: organizationId },
      });

      if (!organization) {
        throw new NotFoundException('Organization not found');
      }

      // Validate pipeline (only for workflow mode)
      const mode = createDto.mode || 'workflow';
      if (mode === 'workflow' && createDto.pipeline) {
        this.validation.validatePipeline(createDto.pipeline);
      }

      const agent = this.agentRepository.create({
        name: createDto.name,
        description: createDto.description,
        organizationId,
        status: createDto.status || AgentStatus.DRAFT,
        version: createDto.version || '1.0.0',
        mode,
        pipeline: createDto.pipeline || { nodes: [], edges: [] },
        instructions: createDto.instructions || null,
        personality: createDto.personality || null,
        heartbeat: createDto.heartbeat || null,
        toolIds: createDto.toolIds || [],
        modelConfig: createDto.modelConfig || null,
        memoryConfig: createDto.memoryConfig || null,
        agentConfig: createDto.agentConfig || null,
        collaboration: createDto.collaboration as Agent['collaboration'] || null,
        variables: createDto.variables || {},
        settings: createDto.settings || {},
        metadata: createDto.metadata || {},
        webhookUrl: createDto.webhookUrl || null,
        createdBy: userId,
        // Team-scoping (#133 partial fix did credentials; this is the
        // matching change for agents). Default to 'org' so omitted
        // payloads keep the historical behavior; drop a stray teamId
        // when visibility='org'.
        visibility: createDto.visibility ?? 'org',
        teamId: createDto.visibility === 'team' ? (createDto.teamId ?? null) : null,
      });

      const saved = await this.agentRepository.save(agent);
      this.logger.log(`[CREATE_AGENT] Agent created: id=${saved.id}`);

      await this.auditService.log({
        agentId: saved.id,
        organizationId,
        userId,
        action: 'created',
        details: { name: saved.name, status: saved.status },
      });

      return saved;
    } catch (error) {
      this.logger.error(`[CREATE_AGENT] Failed: ${error.message}`, error.stack);
      throw error;
    }
  }

  async getAgent(id: string, organizationId: string): Promise<Agent> {
    const agent = await this.agentRepository.findOne({
      where: { id, organizationId },
    });

    if (!agent) {
      throw new NotFoundException(`Agent not found: ${id}`);
    }

    return agent;
  }

  async findByName(name: string, organizationId: string): Promise<Agent | null> {
    // Try exact match first
    let agent = await this.agentRepository.findOne({
      where: { name, organizationId },
    });
    if (agent) return agent;

    // Try case-insensitive match
    agent = await this.agentRepository
      .createQueryBuilder('agent')
      .where('agent.organizationId = :organizationId', { organizationId })
      .andWhere('LOWER(agent.name) = LOWER(:name)', { name })
      .getOne();
    if (agent) return agent;

    // Try slug match: "my-agent" matches "My Agent"
    const deslugified = name.replace(/-/g, ' ');
    agent = await this.agentRepository
      .createQueryBuilder('agent')
      .where('agent.organizationId = :organizationId', { organizationId })
      .andWhere('LOWER(agent.name) = LOWER(:name)', { name: deslugified })
      .getOne();
    return agent;
  }

  async findAllActive(organizationId: string): Promise<Agent[]> {
    return this.agentRepository.find({
      where: { organizationId, status: AgentStatus.ACTIVE },
      order: { createdAt: 'DESC' },
    });
  }

  async getAgents(filters: AgentSearchFilters): Promise<{
    data: Agent[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = filters.page || 1;
    const limit = filters.limit || 20;
    const skip = (page - 1) * limit;

    const queryBuilder = this.agentRepository.createQueryBuilder('agent')
      .andWhere('agent.isTemporary = false');
    // Apply team-scope visibility BEFORE the additional filters
    // (status, search, sort, paging) so the filter participates in
    // the same WHERE block as the rest of the query.
    await this.accessPolicy.applyListFilter(queryBuilder, filters.caller, filters.organizationId, 'agent');

    if (filters.search) {
      queryBuilder.andWhere(
        '(agent.name ILIKE :search OR agent.description ILIKE :search)',
        { search: `%${filters.search}%` },
      );
    }

    if (filters.status) {
      queryBuilder.andWhere('agent.status = :status', { status: filters.status });
    }

    const sortBy = filters.sortBy || 'createdAt';
    const sortOrder = filters.sortOrder || 'DESC';
    queryBuilder.orderBy(`agent.${sortBy}`, sortOrder);

    queryBuilder.skip(skip).take(limit);

    const [data, total] = await queryBuilder.getManyAndCount();

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async updateAgent(
    id: string,
    updateDto: UpdateAgentInput,
    organizationId: string,
    userId?: string,
  ): Promise<Agent> {
    const agent = await this.getAgent(id, organizationId);

    // Permission check: admin+ can update any agent, members can only update their own
    if (userId) {
      await this.checkAgentPermission(agent, organizationId, userId, 'edit_agents');
    }

    // If pipeline is being updated, validate it (only for workflow mode) and auto-save a version snapshot
    const effectiveMode = updateDto.mode || agent.mode || 'workflow';
    if (updateDto.pipeline && effectiveMode === 'workflow') {
      this.validation.validatePipeline(updateDto.pipeline, id);

      // Auto-save previous pipeline state as a version snapshot
      if (agent.pipeline && agent.pipeline.nodes && agent.pipeline.nodes.length > 0) {
        const versions: AgentVersionSnapshot[] = agent.metadata?.versions || [];
        versions.push({
          version: agent.version,
          pipeline: JSON.parse(JSON.stringify(agent.pipeline)),
          savedAt: new Date().toISOString(),
          changelog: `Auto-saved before pipeline update`,
        });
        agent.metadata = { ...agent.metadata, versions };
      }
    }

    Object.assign(agent, updateDto);
    // Sanitize the team-scoping fields after the spread so a flip
    // back to visibility='org' doesn't leave the old teamId dangling.
    if (updateDto.visibility === 'org') {
      agent.teamId = null;
    } else if (updateDto.visibility === 'team' && updateDto.teamId !== undefined) {
      agent.teamId = updateDto.teamId;
    }
    const saved = await this.agentRepository.save(agent);

    this.logger.log(`[UPDATE_AGENT] Agent updated: id=${saved.id}`);

    if (userId) {
      await this.auditService.log({
        agentId: saved.id,
        organizationId,
        userId,
        action: 'updated',
        details: { updatedFields: Object.keys(updateDto) },
      });
    }

    return saved;
  }

  async deleteAgent(id: string, organizationId: string, userId?: string): Promise<void> {
    const agent = await this.getAgent(id, organizationId);

    // Permission check: admin+ can delete any agent, members can only delete their own
    if (userId) {
      await this.checkAgentPermission(agent, organizationId, userId, 'delete_agents');
    }

    // Log before removal since the agent won't exist after
    if (userId) {
      await this.auditService.log({
        agentId: id,
        organizationId,
        userId,
        action: 'deleted',
        details: { name: agent.name },
      });
    }

    await this.agentRepository.remove(agent);
    this.logger.log(`[DELETE_AGENT] Agent deleted: id=${id}`);
  }

  async activateAgent(id: string, organizationId: string, userId?: string): Promise<Agent> {
    const agent = await this.getAgent(id, organizationId);

    // Validate pipeline before activating
    this.validation.validatePipeline(agent.pipeline, agent.id);

    agent.status = AgentStatus.ACTIVE;
    const saved = await this.agentRepository.save(agent);
    this.logger.log(`[ACTIVATE_AGENT] Agent activated: id=${id}`);

    if (userId) {
      await this.auditService.log({ agentId: id, organizationId, userId, action: 'activated' });
    }

    return saved;
  }

  async deactivateAgent(id: string, organizationId: string, userId?: string): Promise<Agent> {
    const agent = await this.getAgent(id, organizationId);
    agent.status = AgentStatus.INACTIVE;
    const saved = await this.agentRepository.save(agent);
    this.logger.log(`[DEACTIVATE_AGENT] Agent deactivated: id=${id}`);

    if (userId) {
      await this.auditService.log({ agentId: id, organizationId, userId, action: 'deactivated' });
    }

    return saved;
  }

  async getAgentExecutions(
    agentId: string,
    organizationId: string,
    page: number = 1,
    limit: number = 20,
  ): Promise<{
    data: AgentExecution[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    // Verify agent exists
    await this.getAgent(agentId, organizationId);

    const skip = (page - 1) * limit;
    const [data, total] = await this.agentExecutionRepository.findAndCount({
      where: { agentId, organizationId },
      order: { createdAt: 'DESC' },
      skip,
      take: limit,
    });

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  // ── Version Management ──

  async saveVersion(agentId: string, organizationId: string, changelog?: string, userId?: string): Promise<void> {
    const agent = await this.getAgent(agentId, organizationId);
    const versions: AgentVersionSnapshot[] = agent.metadata?.versions || [];
    versions.push({
      version: agent.version,
      pipeline: JSON.parse(JSON.stringify(agent.pipeline)),
      savedAt: new Date().toISOString(),
      changelog: changelog || `Version ${agent.version}`,
    });
    await this.agentRepository.update(agentId, {
      metadata: { ...agent.metadata, versions },
    });
    this.logger.log(`[SAVE_VERSION] Saved version for agent=${agentId}, total versions=${versions.length}`);

    if (userId) {
      await this.auditService.log({
        agentId, organizationId, userId,
        action: 'version_saved',
        details: { version: agent.version, changelog },
      });
    }
  }

  async rollbackToVersion(agentId: string, organizationId: string, versionIndex: number, userId?: string): Promise<Agent> {
    const agent = await this.getAgent(agentId, organizationId);
    const versions: AgentVersionSnapshot[] = agent.metadata?.versions || [];
    if (versionIndex < 0 || versionIndex >= versions.length) {
      throw new BadRequestException('Invalid version index');
    }

    // Save the current pipeline state before rolling back so the rollback itself can be undone
    if (agent.pipeline && agent.pipeline.nodes && agent.pipeline.nodes.length > 0) {
      versions.push({
        version: agent.version,
        pipeline: JSON.parse(JSON.stringify(agent.pipeline)),
        savedAt: new Date().toISOString(),
        changelog: `Auto-saved before rollback to version index ${versionIndex}`,
      });
    }

    const targetVersion = versions[versionIndex];
    agent.pipeline = JSON.parse(JSON.stringify(targetVersion.pipeline));
    agent.version = targetVersion.version;
    agent.metadata = { ...agent.metadata, versions };
    const saved = await this.agentRepository.save(agent);
    this.logger.log(`[ROLLBACK] Agent=${agentId} rolled back to version index=${versionIndex}, total versions=${versions.length}`);

    if (userId) {
      await this.auditService.log({
        agentId, organizationId, userId,
        action: 'rolled_back',
        details: { versionIndex, targetVersion: targetVersion.version, totalVersions: versions.length },
      });
    }

    return saved;
  }

  async getVersionHistory(agentId: string, organizationId: string): Promise<AgentVersionSnapshot[]> {
    const agent = await this.getAgent(agentId, organizationId);
    return agent.metadata?.versions || [];
  }

  // ── Templates ──

  getTemplates(): AgentTemplate[] {
    return getAgentTemplates();
  }

  // ── Import / Export ──

  async exportAgent(agentId: string, organizationId: string): Promise<any> {
    const agent = await this.getAgent(agentId, organizationId);
    return {
      name: agent.name,
      description: agent.description,
      pipeline: agent.pipeline,
      variables: agent.variables,
      settings: agent.settings,
      version: agent.version,
      exportedAt: new Date().toISOString(),
      exportVersion: '1.0',
    };
  }

  async importAgent(data: any, organizationId: string, userId: string): Promise<Agent> {
    if (!data || !data.pipeline) {
      throw new BadRequestException('Import data must contain a pipeline');
    }
    return this.createAgent(
      {
        name: (data.name || 'Imported Agent') + ' (Imported)',
        description: data.description,
        pipeline: data.pipeline,
        variables: data.variables,
        settings: data.settings,
      },
      organizationId,
      userId,
    );
  }

  // ── Cost Estimation ──

  /**
   * Estimate the cost per invocation of an agent pipeline based on its nodes.
   * LLM cost is estimated per call based on the model/provider:
   *   - Claude (Anthropic): ~2-4 cents per call
   *   - GPT-4 class (OpenAI): ~3-8 cents per call
   *   - GPT-3.5 / smaller models: ~0.2-1 cent per call
   *   - Unknown/unset: ~1-5 cents per call (conservative range)
   * Tool calls add a small fixed cost (~0.1 cents each).
   */
  async estimateCost(agentId: string, organizationId: string): Promise<EstimatedCost> {
    const agent = await this.getAgent(agentId, organizationId);
    return estimateAgentCost(agent);
  }

  /**
   * Check if user has permission to modify an agent.
   * Creator can always modify their own agent. Otherwise the
   * AccessPolicyService two-tier rule applies: org owner/admin pass,
   * team-scoped agents require team lead, others are denied.
   */
  private async checkAgentPermission(
    agent: Agent,
    organizationId: string,
    userId: string,
    _permission: string,
  ): Promise<void> {
    // If the user created the agent, they can always modify it
    if (agent.createdBy === userId) {
      return;
    }

    const decision = await this.accessPolicy.canAccess({ id: userId }, agent, 'manage');
    if (!decision.allowed) {
      throw new ForbiddenException(decision.reason);
    }
  }

  /**
   * Validate pipeline:
   * - Must have exactly 1 input node
   * - Must have at least 1 output node
   * - Must have no cycles (topological sort)
   * - All edges must reference existing nodes
   * - Condition nodes must have exactly 2 outgoing edges with sourceHandle 'true' and 'false'
   * - Merge nodes must have 2+ incoming edges
   * - Parallel nodes should have 2+ outgoing edges
   * - Sub-agent references must exist and not reference self
   */
}
