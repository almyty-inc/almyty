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
    return this.agentRepository.findOne({
      where: { name, organizationId },
    });
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

    // If pipeline is being updated, validate it (pass agent id to prevent self-recursion)
    if (updateDto.pipeline) {
      this.validatePipeline(updateDto.pipeline, id);
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
          const subAgentId = node.config?.agentId;
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
          if (!node.config?.toolId) {
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
