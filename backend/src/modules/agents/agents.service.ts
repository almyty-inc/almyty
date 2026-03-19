import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like } from 'typeorm';

import { Agent, AgentStatus, AgentPipeline, AgentPipelineNode, AgentPipelineEdge } from '../../entities/agent.entity';
import { AgentExecution } from '../../entities/agent-execution.entity';
import { Organization } from '../../entities/organization.entity';

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
  pipeline: AgentPipeline;
  variables?: Record<string, any>;
  settings?: Record<string, any>;
  metadata?: Record<string, any>;
}

export interface UpdateAgentInput {
  name?: string;
  description?: string;
  status?: AgentStatus;
  version?: string;
  pipeline?: AgentPipeline;
  variables?: Record<string, any>;
  settings?: Record<string, any>;
  metadata?: Record<string, any>;
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

      // Validate pipeline
      this.validatePipeline(createDto.pipeline);

      const agent = this.agentRepository.create({
        name: createDto.name,
        description: createDto.description,
        organizationId,
        status: createDto.status || AgentStatus.DRAFT,
        version: createDto.version || '1.0.0',
        pipeline: createDto.pipeline,
        variables: createDto.variables || {},
        settings: createDto.settings || {},
        metadata: createDto.metadata || {},
        createdBy: userId,
      });

      const saved = await this.agentRepository.save(agent);
      this.logger.log(`[CREATE_AGENT] Agent created: id=${saved.id}`);
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
      .where('agent.organizationId = :organizationId', { organizationId: filters.organizationId });

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
  ): Promise<Agent> {
    const agent = await this.getAgent(id, organizationId);

    // If pipeline is being updated, validate it and auto-save a version snapshot
    if (updateDto.pipeline) {
      this.validatePipeline(updateDto.pipeline, id);

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
    return saved;
  }

  async deleteAgent(id: string, organizationId: string): Promise<void> {
    const agent = await this.getAgent(id, organizationId);
    await this.agentRepository.remove(agent);
    this.logger.log(`[DELETE_AGENT] Agent deleted: id=${id}`);
  }

  async activateAgent(id: string, organizationId: string): Promise<Agent> {
    const agent = await this.getAgent(id, organizationId);

    // Validate pipeline before activating
    this.validatePipeline(agent.pipeline, agent.id);

    agent.status = AgentStatus.ACTIVE;
    const saved = await this.agentRepository.save(agent);
    this.logger.log(`[ACTIVATE_AGENT] Agent activated: id=${id}`);
    return saved;
  }

  async deactivateAgent(id: string, organizationId: string): Promise<Agent> {
    const agent = await this.getAgent(id, organizationId);
    agent.status = AgentStatus.INACTIVE;
    const saved = await this.agentRepository.save(agent);
    this.logger.log(`[DEACTIVATE_AGENT] Agent deactivated: id=${id}`);
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

  async saveVersion(agentId: string, organizationId: string, changelog?: string): Promise<void> {
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
  }

  async rollbackToVersion(agentId: string, organizationId: string, versionIndex: number): Promise<Agent> {
    const agent = await this.getAgent(agentId, organizationId);
    const versions: AgentVersionSnapshot[] = agent.metadata?.versions || [];
    if (versionIndex < 0 || versionIndex >= versions.length) {
      throw new BadRequestException('Invalid version index');
    }
    const targetVersion = versions[versionIndex];
    agent.pipeline = targetVersion.pipeline;
    agent.version = targetVersion.version;
    const saved = await this.agentRepository.save(agent);
    this.logger.log(`[ROLLBACK] Agent=${agentId} rolled back to version index=${versionIndex}`);
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

  async estimateCost(agentId: string, organizationId: string): Promise<any> {
    const agent = await this.getAgent(agentId, organizationId);
    const llmNodes = agent.pipeline.nodes.filter(
      (n: any) => n.type === 'llm_call' || n.type === 'merge',
    );
    const toolCallNodes = agent.pipeline.nodes.filter(
      (n: any) => n.type === 'tool_call',
    );
    const parallelNodes = agent.pipeline.nodes.filter(
      (n: any) => n.type === 'parallel',
    );

    const estimatedCalls = llmNodes.length;

    return {
      estimatedLlmCalls: estimatedCalls,
      estimatedToolCalls: toolCallNodes.length,
      hasParallelExecution: parallelNodes.length > 0,
      estimatedCostRange: {
        low: estimatedCalls * 0.5, // cents
        high: estimatedCalls * 10, // cents
      },
      nodeCount: agent.pipeline.nodes.length,
      edgeCount: agent.pipeline.edges.length,
    };
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
  validatePipeline(pipeline: AgentPipeline, agentId?: string): void {
    if (!pipeline || !pipeline.nodes || !pipeline.edges) {
      throw new BadRequestException('Pipeline must have nodes and edges arrays');
    }

    if (!Array.isArray(pipeline.nodes) || !Array.isArray(pipeline.edges)) {
      throw new BadRequestException('Pipeline nodes and edges must be arrays');
    }

    // Check for input nodes
    const inputNodes = pipeline.nodes.filter(n => n.type === 'input');
    if (inputNodes.length !== 1) {
      throw new BadRequestException(`Pipeline must have exactly 1 input node, found ${inputNodes.length}`);
    }

    // Check for output nodes
    const outputNodes = pipeline.nodes.filter(n => n.type === 'output');
    if (outputNodes.length < 1) {
      throw new BadRequestException('Pipeline must have at least 1 output node');
    }

    // Check that node IDs are unique
    const nodeIds = new Set(pipeline.nodes.map(n => n.id));
    if (nodeIds.size !== pipeline.nodes.length) {
      throw new BadRequestException('Pipeline node IDs must be unique');
    }

    // Check that all edges reference existing nodes
    for (const edge of pipeline.edges) {
      if (!nodeIds.has(edge.source)) {
        throw new BadRequestException(`Edge source '${edge.source}' does not reference an existing node`);
      }
      if (!nodeIds.has(edge.target)) {
        throw new BadRequestException(`Edge target '${edge.target}' does not reference an existing node`);
      }
    }

    // Build edge lookup maps for advanced validation
    const outgoingEdges = new Map<string, AgentPipelineEdge[]>();
    const incomingEdges = new Map<string, AgentPipelineEdge[]>();
    for (const node of pipeline.nodes) {
      outgoingEdges.set(node.id, []);
      incomingEdges.set(node.id, []);
    }
    for (const edge of pipeline.edges) {
      outgoingEdges.get(edge.source)?.push(edge);
      incomingEdges.get(edge.target)?.push(edge);
    }

    // Validate specific node types
    for (const node of pipeline.nodes) {
      switch (node.type) {
        case 'condition': {
          const outEdges = outgoingEdges.get(node.id) || [];
          if (outEdges.length !== 2) {
            throw new BadRequestException(
              `Condition node '${node.id}' must have exactly 2 outgoing edges, found ${outEdges.length}`,
            );
          }
          const handles = outEdges.map(e => e.sourceHandle || e.label || '').sort();
          const hasTrueFalse =
            (handles.includes('true') && handles.includes('false')) ||
            (handles.includes('yes') && handles.includes('no'));
          if (!hasTrueFalse) {
            throw new BadRequestException(
              `Condition node '${node.id}' outgoing edges must have sourceHandle 'true'/'false' (or 'yes'/'no'), found: ${handles.join(', ')}`,
            );
          }
          break;
        }

        case 'merge': {
          const inEdges = incomingEdges.get(node.id) || [];
          if (inEdges.length < 2) {
            throw new BadRequestException(
              `Merge node '${node.id}' must have at least 2 incoming edges, found ${inEdges.length}`,
            );
          }
          break;
        }

        case 'parallel': {
          const outEdges = outgoingEdges.get(node.id) || [];
          if (outEdges.length < 2) {
            throw new BadRequestException(
              `Parallel node '${node.id}' should have at least 2 outgoing edges, found ${outEdges.length}`,
            );
          }
          break;
        }

        case 'sub_agent': {
          const nodeData = node.data || node.config || {};
          const subAgentId = nodeData.agentId;
          if (!subAgentId) {
            throw new BadRequestException(
              `Sub-agent node '${node.id}' must have 'agentId' in config`,
            );
          }
          // Prevent direct self-recursion
          if (agentId && subAgentId === agentId) {
            throw new BadRequestException(
              `Sub-agent node '${node.id}' cannot reference the same agent (self-recursion)`,
            );
          }
          break;
        }

        case 'tool_call': {
          const toolData = node.data || node.config || {};
          if (!toolData.toolId) {
            throw new BadRequestException(
              `Tool call node '${node.id}' must have 'toolId' in config`,
            );
          }
          break;
        }
      }
    }

    // Check for cycles via topological sort
    this.checkForCycles(pipeline);
  }

  private checkForCycles(pipeline: AgentPipeline): void {
    const adjacencyList = new Map<string, string[]>();
    const inDegree = new Map<string, number>();

    for (const node of pipeline.nodes) {
      adjacencyList.set(node.id, []);
      inDegree.set(node.id, 0);
    }

    for (const edge of pipeline.edges) {
      const neighbors = adjacencyList.get(edge.source) || [];
      neighbors.push(edge.target);
      adjacencyList.set(edge.source, neighbors);
      inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
    }

    const queue: string[] = [];
    for (const node of pipeline.nodes) {
      if ((inDegree.get(node.id) || 0) === 0) {
        queue.push(node.id);
      }
    }

    let visited = 0;
    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      visited++;
      const neighbors = adjacencyList.get(nodeId) || [];
      for (const neighbor of neighbors) {
        const newDegree = (inDegree.get(neighbor) || 0) - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) {
          queue.push(neighbor);
        }
      }
    }

    if (visited !== pipeline.nodes.length) {
      throw new BadRequestException('Pipeline contains a cycle');
    }
  }
}
