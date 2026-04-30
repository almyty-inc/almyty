import { AgentValidationHelper } from './agent-validation.helper';
import { Injectable, Logger, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Agent, AgentStatus, AgentPipeline, AgentPipelineNode, AgentPipelineEdge } from '../../entities/agent.entity';
import { AgentExecution } from '../../entities/agent-execution.entity';
import { Organization } from '../../entities/organization.entity';
import { User } from '../../entities/user.entity';
import { AgentAuditService } from './agent-audit.service';

export interface AgentSearchFilters {
  search?: string;
  status?: AgentStatus;
  organizationId: string;
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
}

export interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  pipeline: AgentPipeline;
}

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
      .where('agent.organizationId = :organizationId', { organizationId: filters.organizationId })
      .andWhere('agent.isTemporary = false');

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
    return [
      {
        id: 'simple-chat',
        name: 'Simple Chat Agent',
        description: 'Single LLM with tools — the basic conversational agent',
        category: 'basic',
        pipeline: {
          nodes: [
            { id: 'input_1', type: 'input', position: { x: 50, y: 200 }, config: {}, data: { schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } } } as any,
            { id: 'llm_1', type: 'llm_call', position: { x: 350, y: 200 }, config: {}, data: { providerId: '', userPromptTemplate: '{{input.message}}', systemPrompt: 'You are a helpful assistant.' } } as any,
            { id: 'output_1', type: 'output', position: { x: 650, y: 200 }, config: {}, data: { mapping: '{{nodes.llm_1.output}}' } } as any,
          ],
          edges: [
            { id: 'e1', source: 'input_1', target: 'llm_1' },
            { id: 'e2', source: 'llm_1', target: 'output_1' },
          ],
        },
      },
      {
        id: 'multi-llm-consensus',
        name: 'Multi-LLM Consensus',
        description: 'Send prompt to multiple LLMs in parallel, then use a judge to pick the best answer',
        category: 'advanced',
        pipeline: {
          nodes: [
            { id: 'input_1', type: 'input', position: { x: 50, y: 250 }, config: {}, data: { schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } } } as any,
            { id: 'parallel_1', type: 'parallel', position: { x: 250, y: 250 }, config: {} } as any,
            { id: 'llm_a', type: 'llm_call', position: { x: 500, y: 100 }, config: {}, data: { providerId: '', userPromptTemplate: '{{input.message}}', systemPrompt: 'You are a helpful assistant.' } } as any,
            { id: 'llm_b', type: 'llm_call', position: { x: 500, y: 400 }, config: {}, data: { providerId: '', userPromptTemplate: '{{input.message}}', systemPrompt: 'You are a helpful assistant.' } } as any,
            { id: 'merge_1', type: 'merge', position: { x: 750, y: 250 }, config: {}, data: { strategy: 'best_of_n', judgeConfig: { providerId: '' } } } as any,
            { id: 'output_1', type: 'output', position: { x: 1000, y: 250 }, config: {}, data: { mapping: '{{nodes.merge_1.output}}' } } as any,
          ],
          edges: [
            { id: 'e1', source: 'input_1', target: 'parallel_1' },
            { id: 'e2', source: 'parallel_1', target: 'llm_a' },
            { id: 'e3', source: 'parallel_1', target: 'llm_b' },
            { id: 'e4', source: 'llm_a', target: 'merge_1' },
            { id: 'e5', source: 'llm_b', target: 'merge_1' },
            { id: 'e6', source: 'merge_1', target: 'output_1' },
          ],
        },
      },
      {
        id: 'research-agent',
        name: 'Research Agent',
        description: 'Extract facts with one LLM, then summarize with another — sequential chain',
        category: 'advanced',
        pipeline: {
          nodes: [
            { id: 'input_1', type: 'input', position: { x: 50, y: 200 }, config: {}, data: { schema: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] } } } as any,
            { id: 'llm_extract', type: 'llm_call', position: { x: 300, y: 200 }, config: {}, data: { providerId: '', userPromptTemplate: 'Research and list key facts about: {{input.topic}}', systemPrompt: 'You are a research assistant. List facts as bullet points.', responseFormat: 'text' } } as any,
            { id: 'transform_1', type: 'transform', position: { x: 550, y: 200 }, config: {}, data: { expression: '{{nodes.llm_extract.output}}' } } as any,
            { id: 'llm_summarize', type: 'llm_call', position: { x: 800, y: 200 }, config: {}, data: { providerId: '', userPromptTemplate: 'Write a concise summary from these facts:\n\n{{nodes.transform_1.output}}', systemPrompt: 'You are a skilled writer. Produce clear, concise summaries.' } } as any,
            { id: 'output_1', type: 'output', position: { x: 1050, y: 200 }, config: {}, data: { mapping: '{{nodes.llm_summarize.output}}' } } as any,
          ],
          edges: [
            { id: 'e1', source: 'input_1', target: 'llm_extract' },
            { id: 'e2', source: 'llm_extract', target: 'transform_1' },
            { id: 'e3', source: 'transform_1', target: 'llm_summarize' },
            { id: 'e4', source: 'llm_summarize', target: 'output_1' },
          ],
        },
      },
      {
        id: 'tool-augmented',
        name: 'Tool-Augmented Agent',
        description: 'LLM with access to your API tools — the standard agentic pattern',
        category: 'basic',
        pipeline: {
          nodes: [
            { id: 'input_1', type: 'input', position: { x: 50, y: 200 }, config: {}, data: { schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } } } as any,
            { id: 'llm_1', type: 'llm_call', position: { x: 350, y: 200 }, config: {}, data: { providerId: '', userPromptTemplate: '{{input.message}}', systemPrompt: 'You are a helpful assistant with access to tools. Use them when needed.', toolIds: [], maxToolRounds: 5 } } as any,
            { id: 'output_1', type: 'output', position: { x: 650, y: 200 }, config: {}, data: { mapping: '{{nodes.llm_1.output}}' } } as any,
          ],
          edges: [
            { id: 'e1', source: 'input_1', target: 'llm_1' },
            { id: 'e2', source: 'llm_1', target: 'output_1' },
          ],
        },
      },
    ];
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
  async estimateCost(agentId: string, organizationId: string): Promise<any> {
    const agent = await this.getAgent(agentId, organizationId);
    // Only merge strategies that actually call an LLM count toward the cost
    // estimate. `first_response` and `concatenate` are pure bookkeeping and
    // don't touch the LLM — counting them as LLM calls over-estimated cost.
    const LLM_MERGE_STRATEGIES = new Set(['best_of_n', 'consensus']);
    const llmNodes = agent.pipeline.nodes.filter((n: any) => {
      if (n.type === 'llm_call') return true;
      if (n.type === 'merge') {
        const strategy = n.data?.strategy || n.config?.strategy;
        return LLM_MERGE_STRATEGIES.has(strategy);
      }
      return false;
    });
    const toolCallNodes = agent.pipeline.nodes.filter(
      (n: any) => n.type === 'tool_call',
    );
    const parallelNodes = agent.pipeline.nodes.filter(
      (n: any) => n.type === 'parallel',
    );

    // Estimate cost per LLM node based on model/provider
    let totalLow = 0;
    let totalHigh = 0;
    for (const node of llmNodes) {
      const model = ((node.data?.model as string) || '').toLowerCase();
      const providerType = ((node.data?.providerType as string) || '').toLowerCase();
      const { low, high } = this.estimateNodeCost(model, providerType);
      totalLow += low;
      totalHigh += high;
    }

    // Add a small cost per tool call (API execution overhead)
    const toolCost = toolCallNodes.length * 0.1;
    totalLow += toolCost;
    totalHigh += toolCost;

    // If no LLM nodes exist, report zero
    if (llmNodes.length === 0 && toolCallNodes.length === 0) {
      totalLow = 0;
      totalHigh = 0;
    }

    return {
      estimatedLlmCalls: llmNodes.length,
      estimatedToolCalls: toolCallNodes.length,
      hasParallelExecution: parallelNodes.length > 0,
      estimatedCostRange: {
        low: Math.round(totalLow * 10) / 10,
        high: Math.round(totalHigh * 10) / 10,
      },
      nodeCount: agent.pipeline.nodes.length,
      edgeCount: agent.pipeline.edges.length,
    };
  }

  /**
   * Return low/high cost estimate in cents for a single LLM call
   * based on model name and provider type.
   */
  private estimateNodeCost(
    model: string,
    providerType: string,
  ): { low: number; high: number } {
    // Cheap OpenAI models (check before gpt-4o since gpt-4o-mini contains gpt-4o)
    if (model.includes('gpt-3.5') || model.includes('gpt-4o-mini') || model.includes('mini')) {
      return { low: 0.2, high: 1 };
    }
    // GPT-4 class models (expensive)
    if (model.includes('gpt-4o')) {
      return { low: 1, high: 4 };
    }
    if (model.includes('gpt-4')) {
      return { low: 3, high: 8 };
    }
    // Claude models
    if (model.includes('opus')) {
      return { low: 5, high: 15 };
    }
    if (model.includes('sonnet')) {
      return { low: 1, high: 4 };
    }
    if (model.includes('haiku')) {
      return { low: 0.2, high: 1 };
    }
    if (model.includes('claude')) {
      return { low: 2, high: 4 };
    }
    // Provider-based fallback when model is unknown/empty
    if (providerType === 'anthropic') {
      return { low: 2, high: 4 };
    }
    if (providerType === 'openai') {
      return { low: 1, high: 5 };
    }
    // Completely unknown — conservative range
    return { low: 1, high: 5 };
  }

  /**
   * Check if user has permission to modify an agent.
   * Admin/owner roles can modify any agent. Members can only modify agents they created.
   */
  private async checkAgentPermission(
    agent: Agent,
    organizationId: string,
    userId: string,
    permission: string,
  ): Promise<void> {
    // If the user created the agent, they can always modify it
    if (agent.createdBy === userId) {
      return;
    }

    // Otherwise check if they have the admin-level permission
    const user = await this.userRepository.findOne({
      where: { id: userId },
      relations: ['organizationMemberships'],
    });

    if (!user?.hasPermissionInOrganization(organizationId, permission)) {
      throw new ForbiddenException('You do not have permission to modify this agent');
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
