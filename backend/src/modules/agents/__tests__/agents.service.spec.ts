import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { AgentsService, CreateAgentInput, UpdateAgentInput } from '../agents.service';
import { Agent, AgentStatus, AgentPipeline } from '../../../entities/agent.entity';
import { AgentExecution } from '../../../entities/agent-execution.entity';
import { Organization } from '../../../entities/organization.entity';

// ─── Helper factories ───────────────────────────────────────────────────────

function makeOrganization(overrides: Partial<Organization> = {}): Organization {
  const org = new Organization();
  org.id = 'org-1';
  org.name = 'Test Org';
  org.slug = 'test-org';
  org.isActive = true;
  org.settings = {};
  return Object.assign(org, overrides);
}

function makeValidPipeline(overrides: Partial<AgentPipeline> = {}): AgentPipeline {
  return {
    nodes: [
      { id: 'input_1', type: 'input', config: {} },
      { id: 'llm_1', type: 'llm_call', config: {}, data: { providerId: 'p-1', userPromptTemplate: '{{input.message}}' } },
      { id: 'output_1', type: 'output', config: {}, data: { mapping: '{{nodes.llm_1.output}}' } },
    ],
    edges: [
      { id: 'e1', source: 'input_1', target: 'llm_1' },
      { id: 'e2', source: 'llm_1', target: 'output_1' },
    ],
    ...overrides,
  };
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  const agent = new Agent();
  agent.id = 'agent-1';
  agent.name = 'Test Agent';
  agent.description = 'A test agent';
  agent.organizationId = 'org-1';
  agent.status = AgentStatus.DRAFT;
  agent.version = '1.0.0';
  agent.pipeline = makeValidPipeline();
  agent.variables = {};
  agent.settings = {};
  agent.metadata = {};
  agent.totalExecutions = 0;
  agent.successfulExecutions = 0;
  agent.totalCost = 0;
  agent.averageExecutionTime = 0;
  agent.createdBy = 'user-1';
  agent.createdAt = new Date();
  agent.updatedAt = new Date();
  agent.incrementExecution = Agent.prototype.incrementExecution;
  agent.isActive = Agent.prototype.isActive;
  agent.getSuccessRate = Agent.prototype.getSuccessRate;
  return Object.assign(agent, overrides);
}

function makeQueryBuilder(returnAgents: Agent[] = [], total = 0) {
  const qb: any = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([returnAgents, total]),
  };
  return qb;
}

// ─── Test suite ─────────────────────────────────────────────────────────────

describe('AgentsService', () => {
  let service: AgentsService;

  let agentRepo: jest.Mocked<any>;
  let agentExecutionRepo: jest.Mocked<any>;
  let organizationRepo: jest.Mocked<any>;

  beforeEach(async () => {
    agentRepo = {
      create: jest.fn(),
      save: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn(),
      remove: jest.fn(),
      update: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    agentExecutionRepo = {
      create: jest.fn(),
      save: jest.fn(),
      findAndCount: jest.fn(),
    };

    organizationRepo = {
      findOne: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentsService,
        { provide: getRepositoryToken(Agent), useValue: agentRepo },
        { provide: getRepositoryToken(AgentExecution), useValue: agentExecutionRepo },
        { provide: getRepositoryToken(Organization), useValue: organizationRepo },
      ],
    }).compile();

    service = module.get<AgentsService>(AgentsService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── createAgent ───────────────────────────────────────────────────────────

  describe('createAgent', () => {
    const dto: CreateAgentInput = {
      name: 'My Agent',
      description: 'Test agent',
      pipeline: makeValidPipeline(),
    };

    it('should create an agent with valid pipeline and set status to draft', async () => {
      const org = makeOrganization();
      const agent = makeAgent({ name: dto.name });

      organizationRepo.findOne.mockResolvedValue(org);
      agentRepo.create.mockReturnValue(agent);
      agentRepo.save.mockResolvedValue(agent);

      const result = await service.createAgent(dto, 'org-1', 'user-1');

      expect(organizationRepo.findOne).toHaveBeenCalledWith({ where: { id: 'org-1' } });
      expect(agentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: dto.name,
          organizationId: 'org-1',
          status: AgentStatus.DRAFT,
          version: '1.0.0',
          createdBy: 'user-1',
        }),
      );
      expect(agentRepo.save).toHaveBeenCalledWith(agent);
      expect(result).toBe(agent);
    });

    it('should throw NotFoundException when organization is not found', async () => {
      organizationRepo.findOne.mockResolvedValue(null);

      await expect(service.createAgent(dto, 'org-missing', 'user-1'))
        .rejects.toThrow(NotFoundException);
    });

    it('should reject pipeline with no input node', async () => {
      const org = makeOrganization();
      organizationRepo.findOne.mockResolvedValue(org);

      const badDto: CreateAgentInput = {
        name: 'Bad Agent',
        pipeline: {
          nodes: [
            { id: 'llm_1', type: 'llm_call', config: {} },
            { id: 'output_1', type: 'output', config: {} },
          ],
          edges: [{ id: 'e1', source: 'llm_1', target: 'output_1' }],
        },
      };

      await expect(service.createAgent(badDto, 'org-1', 'user-1'))
        .rejects.toThrow(BadRequestException);
    });

    it('should reject pipeline with cycles', async () => {
      const org = makeOrganization();
      organizationRepo.findOne.mockResolvedValue(org);

      const cyclicDto: CreateAgentInput = {
        name: 'Cyclic Agent',
        pipeline: {
          nodes: [
            { id: 'input_1', type: 'input', config: {} },
            { id: 'a', type: 'llm_call', config: {} },
            { id: 'b', type: 'transform', config: {} },
            { id: 'output_1', type: 'output', config: {} },
          ],
          edges: [
            { id: 'e1', source: 'input_1', target: 'a' },
            { id: 'e2', source: 'a', target: 'b' },
            { id: 'e3', source: 'b', target: 'a' }, // cycle
            { id: 'e4', source: 'b', target: 'output_1' },
          ],
        },
      };

      await expect(service.createAgent(cyclicDto, 'org-1', 'user-1'))
        .rejects.toThrow(BadRequestException);
    });

    it('should reject pipeline with invalid edges referencing non-existent nodes', async () => {
      const org = makeOrganization();
      organizationRepo.findOne.mockResolvedValue(org);

      const badEdgeDto: CreateAgentInput = {
        name: 'Bad Edge Agent',
        pipeline: {
          nodes: [
            { id: 'input_1', type: 'input', config: {} },
            { id: 'output_1', type: 'output', config: {} },
          ],
          edges: [
            { id: 'e1', source: 'input_1', target: 'ghost_node' },
          ],
        },
      };

      await expect(service.createAgent(badEdgeDto, 'org-1', 'user-1'))
        .rejects.toThrow(BadRequestException);
    });
  });

  // ── updateAgent ───────────────────────────────────────────────────────────

  describe('updateAgent', () => {
    it('should update name and description', async () => {
      const agent = makeAgent();
      agentRepo.findOne.mockResolvedValue(agent);
      agentRepo.save.mockResolvedValue({ ...agent, name: 'Updated', description: 'New desc' });

      const updateDto: UpdateAgentInput = { name: 'Updated', description: 'New desc' };
      const result = await service.updateAgent('agent-1', updateDto, 'org-1');

      expect(agentRepo.findOne).toHaveBeenCalledWith({ where: { id: 'agent-1', organizationId: 'org-1' } });
      expect(agentRepo.save).toHaveBeenCalled();
      expect(result.name).toBe('Updated');
    });

    it('should auto-save version snapshot on pipeline change', async () => {
      const agent = makeAgent({
        pipeline: makeValidPipeline(),
        version: '1.0.0',
        metadata: {},
      });
      agentRepo.findOne.mockResolvedValue(agent);
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      const newPipeline = makeValidPipeline();
      const updateDto: UpdateAgentInput = { pipeline: newPipeline };
      const result = await service.updateAgent('agent-1', updateDto, 'org-1');

      // Should have saved version snapshot in metadata
      expect(result.metadata.versions).toBeDefined();
      expect(result.metadata.versions).toHaveLength(1);
      expect(result.metadata.versions[0].version).toBe('1.0.0');
      expect(result.metadata.versions[0].changelog).toContain('Auto-saved');
    });

    it('should throw NotFoundException when agent does not exist', async () => {
      agentRepo.findOne.mockResolvedValue(null);

      await expect(service.updateAgent('missing', { name: 'X' }, 'org-1'))
        .rejects.toThrow(NotFoundException);
    });

    it('should validate new pipeline on update', async () => {
      const agent = makeAgent();
      agentRepo.findOne.mockResolvedValue(agent);

      const badPipeline: AgentPipeline = {
        nodes: [
          { id: 'llm_1', type: 'llm_call', config: {} },
        ],
        edges: [],
      };

      await expect(service.updateAgent('agent-1', { pipeline: badPipeline }, 'org-1'))
        .rejects.toThrow(BadRequestException);
    });
  });

  // ── getAgent ──────────────────────────────────────────────────────────────

  describe('getAgent', () => {
    it('should return agent by id and organizationId', async () => {
      const agent = makeAgent();
      agentRepo.findOne.mockResolvedValue(agent);

      const result = await service.getAgent('agent-1', 'org-1');

      expect(agentRepo.findOne).toHaveBeenCalledWith({ where: { id: 'agent-1', organizationId: 'org-1' } });
      expect(result).toBe(agent);
    });

    it('should throw NotFoundException when agent is not found', async () => {
      agentRepo.findOne.mockResolvedValue(null);

      await expect(service.getAgent('missing', 'org-1'))
        .rejects.toThrow(NotFoundException);
    });
  });

  // ── deleteAgent ───────────────────────────────────────────────────────────

  describe('deleteAgent', () => {
    it('should remove the agent', async () => {
      const agent = makeAgent();
      agentRepo.findOne.mockResolvedValue(agent);
      agentRepo.remove.mockResolvedValue(agent);

      await service.deleteAgent('agent-1', 'org-1');

      expect(agentRepo.remove).toHaveBeenCalledWith(agent);
    });

    it('should throw NotFoundException if agent does not exist', async () => {
      agentRepo.findOne.mockResolvedValue(null);

      await expect(service.deleteAgent('missing', 'org-1'))
        .rejects.toThrow(NotFoundException);
    });
  });

  // ── activateAgent ─────────────────────────────────────────────────────────

  describe('activateAgent', () => {
    it('should set status to active', async () => {
      const agent = makeAgent();
      agentRepo.findOne.mockResolvedValue(agent);
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      const result = await service.activateAgent('agent-1', 'org-1');

      expect(result.status).toBe(AgentStatus.ACTIVE);
      expect(agentRepo.save).toHaveBeenCalled();
    });

    it('should validate pipeline before activating', async () => {
      const agent = makeAgent({
        pipeline: {
          nodes: [{ id: 'llm_1', type: 'llm_call', config: {} }],
          edges: [],
        },
      });
      agentRepo.findOne.mockResolvedValue(agent);

      await expect(service.activateAgent('agent-1', 'org-1'))
        .rejects.toThrow(BadRequestException);
    });
  });

  // ── deactivateAgent ───────────────────────────────────────────────────────

  describe('deactivateAgent', () => {
    it('should set status to inactive', async () => {
      const agent = makeAgent({ status: AgentStatus.ACTIVE });
      agentRepo.findOne.mockResolvedValue(agent);
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      const result = await service.deactivateAgent('agent-1', 'org-1');

      expect(result.status).toBe(AgentStatus.INACTIVE);
      expect(agentRepo.save).toHaveBeenCalled();
    });
  });

  // ── Pipeline validation ───────────────────────────────────────────────────

  describe('validatePipeline', () => {
    it('should reject pipeline with no output node', () => {
      const pipeline: AgentPipeline = {
        nodes: [
          { id: 'input_1', type: 'input', config: {} },
          { id: 'llm_1', type: 'llm_call', config: {} },
        ],
        edges: [
          { id: 'e1', source: 'input_1', target: 'llm_1' },
        ],
      };

      expect(() => service['validatePipeline'](pipeline)).toThrow(BadRequestException);
      expect(() => service['validatePipeline'](pipeline)).toThrow('at least 1 output node');
    });

    it('should reject condition node with wrong number of outgoing edges', () => {
      const pipeline: AgentPipeline = {
        nodes: [
          { id: 'input_1', type: 'input', config: {} },
          { id: 'cond_1', type: 'condition', config: {}, data: { expression: '{{input.flag}}' } },
          { id: 'llm_1', type: 'llm_call', config: {} },
          { id: 'output_1', type: 'output', config: {} },
        ],
        edges: [
          { id: 'e1', source: 'input_1', target: 'cond_1' },
          { id: 'e2', source: 'cond_1', target: 'llm_1', sourceHandle: 'true' },
          // Missing 'false' edge
          { id: 'e3', source: 'llm_1', target: 'output_1' },
        ],
      };

      expect(() => service['validatePipeline'](pipeline)).toThrow(BadRequestException);
      expect(() => service['validatePipeline'](pipeline)).toThrow('exactly 2 outgoing edges');
    });

    it('should reject merge node with fewer than 2 incoming edges', () => {
      const pipeline: AgentPipeline = {
        nodes: [
          { id: 'input_1', type: 'input', config: {} },
          { id: 'llm_1', type: 'llm_call', config: {} },
          { id: 'merge_1', type: 'merge', config: {} },
          { id: 'output_1', type: 'output', config: {} },
        ],
        edges: [
          { id: 'e1', source: 'input_1', target: 'llm_1' },
          { id: 'e2', source: 'llm_1', target: 'merge_1' }, // only 1 incoming
          { id: 'e3', source: 'merge_1', target: 'output_1' },
        ],
      };

      expect(() => service['validatePipeline'](pipeline)).toThrow(BadRequestException);
      expect(() => service['validatePipeline'](pipeline)).toThrow('at least 2 incoming edges');
    });

    it('should reject pipeline with null/undefined', () => {
      expect(() => service['validatePipeline'](null as any)).toThrow(BadRequestException);
      expect(() => service['validatePipeline'](undefined as any)).toThrow(BadRequestException);
    });

    it('should reject pipeline where nodes or edges are not arrays', () => {
      expect(() => service['validatePipeline']({ nodes: 'bad', edges: [] } as any))
        .toThrow(BadRequestException);
    });

    it('should reject pipeline with duplicate node IDs', () => {
      const pipeline: AgentPipeline = {
        nodes: [
          { id: 'input_1', type: 'input', config: {} },
          { id: 'input_1', type: 'llm_call', config: {} }, // duplicate
          { id: 'output_1', type: 'output', config: {} },
        ],
        edges: [
          { id: 'e1', source: 'input_1', target: 'output_1' },
        ],
      };

      expect(() => service['validatePipeline'](pipeline)).toThrow(BadRequestException);
    });

    it('should reject parallel node with fewer than 2 outgoing edges', () => {
      const pipeline: AgentPipeline = {
        nodes: [
          { id: 'input_1', type: 'input', config: {} },
          { id: 'par_1', type: 'parallel', config: {} },
          { id: 'llm_1', type: 'llm_call', config: {} },
          { id: 'llm_2', type: 'llm_call', config: {} },
          { id: 'merge_1', type: 'merge', config: {} },
          { id: 'output_1', type: 'output', config: {} },
        ],
        edges: [
          { id: 'e1', source: 'input_1', target: 'par_1' },
          { id: 'e2', source: 'par_1', target: 'llm_1' }, // only 1 outgoing
          { id: 'e3', source: 'llm_1', target: 'merge_1' },
          { id: 'e4', source: 'llm_2', target: 'merge_1' },
          { id: 'e5', source: 'merge_1', target: 'output_1' },
        ],
      };

      expect(() => service['validatePipeline'](pipeline)).toThrow(BadRequestException);
      expect(() => service['validatePipeline'](pipeline)).toThrow('at least 2 outgoing edges');
    });

    it('should accept a valid pipeline with condition branching', () => {
      const pipeline: AgentPipeline = {
        nodes: [
          { id: 'input_1', type: 'input', config: {} },
          { id: 'cond_1', type: 'condition', config: {}, data: { expression: '{{input.flag}}' } },
          { id: 'llm_true', type: 'llm_call', config: {} },
          { id: 'llm_false', type: 'llm_call', config: {} },
          { id: 'output_1', type: 'output', config: {} },
          { id: 'output_2', type: 'output', config: {} },
        ],
        edges: [
          { id: 'e1', source: 'input_1', target: 'cond_1' },
          { id: 'e2', source: 'cond_1', target: 'llm_true', sourceHandle: 'true' },
          { id: 'e3', source: 'cond_1', target: 'llm_false', sourceHandle: 'false' },
          { id: 'e4', source: 'llm_true', target: 'output_1' },
          { id: 'e5', source: 'llm_false', target: 'output_2' },
        ],
      };

      expect(() => service['validatePipeline'](pipeline)).not.toThrow();
    });

    it('should reject sub_agent node referencing itself', () => {
      const pipeline: AgentPipeline = {
        nodes: [
          { id: 'input_1', type: 'input', config: {} },
          { id: 'sub_1', type: 'sub_agent', config: {}, data: { agentId: 'self-agent' } },
          { id: 'output_1', type: 'output', config: {} },
        ],
        edges: [
          { id: 'e1', source: 'input_1', target: 'sub_1' },
          { id: 'e2', source: 'sub_1', target: 'output_1' },
        ],
      };

      expect(() => service['validatePipeline'](pipeline, 'self-agent'))
        .toThrow(BadRequestException);
      expect(() => service['validatePipeline'](pipeline, 'self-agent'))
        .toThrow('self-recursion');
    });

    it('should reject tool_call node without toolId', () => {
      const pipeline: AgentPipeline = {
        nodes: [
          { id: 'input_1', type: 'input', config: {} },
          { id: 'tool_1', type: 'tool_call', config: {}, data: {} },
          { id: 'output_1', type: 'output', config: {} },
        ],
        edges: [
          { id: 'e1', source: 'input_1', target: 'tool_1' },
          { id: 'e2', source: 'tool_1', target: 'output_1' },
        ],
      };

      expect(() => service['validatePipeline'](pipeline))
        .toThrow(BadRequestException);
      expect(() => service['validatePipeline'](pipeline))
        .toThrow('toolId');
    });
  });

  // ── findByName ────────────────────────────────────────────────────────────

  describe('findByName', () => {
    it('should find agent by name and organizationId', async () => {
      const agent = makeAgent();
      agentRepo.findOne.mockResolvedValue(agent);

      const result = await service.findByName('Test Agent', 'org-1');

      expect(agentRepo.findOne).toHaveBeenCalledWith({ where: { name: 'Test Agent', organizationId: 'org-1' } });
      expect(result).toBe(agent);
    });

    it('should return null when agent is not found', async () => {
      agentRepo.findOne.mockResolvedValue(null);

      const result = await service.findByName('Nonexistent', 'org-1');
      expect(result).toBeNull();
    });
  });

  // ── getTemplates ──────────────────────────────────────────────────────────

  describe('getTemplates', () => {
    it('should return 4 templates', () => {
      const templates = service.getTemplates();

      expect(templates).toHaveLength(4);
    });

    it('should return templates with required fields', () => {
      const templates = service.getTemplates();

      for (const tpl of templates) {
        expect(tpl.id).toBeDefined();
        expect(tpl.name).toBeDefined();
        expect(tpl.description).toBeDefined();
        expect(tpl.category).toBeDefined();
        expect(tpl.pipeline).toBeDefined();
        expect(tpl.pipeline.nodes).toBeDefined();
        expect(tpl.pipeline.edges).toBeDefined();
      }
    });

    it('should include simple-chat and tool-augmented templates', () => {
      const templates = service.getTemplates();
      const ids = templates.map(t => t.id);

      expect(ids).toContain('simple-chat');
      expect(ids).toContain('tool-augmented');
      expect(ids).toContain('multi-llm-consensus');
      expect(ids).toContain('research-agent');
    });
  });

  // ── exportAgent ───────────────────────────────────────────────────────────

  describe('exportAgent', () => {
    it('should return portable JSON with agent data', async () => {
      const agent = makeAgent({
        name: 'Export Agent',
        description: 'For export',
        version: '2.0.0',
        variables: { key: 'val' },
        settings: { timeout: 5000 },
      });
      agentRepo.findOne.mockResolvedValue(agent);

      const result = await service.exportAgent('agent-1', 'org-1');

      expect(result.name).toBe('Export Agent');
      expect(result.description).toBe('For export');
      expect(result.version).toBe('2.0.0');
      expect(result.pipeline).toBeDefined();
      expect(result.variables).toEqual({ key: 'val' });
      expect(result.settings).toEqual({ timeout: 5000 });
      expect(result.exportedAt).toBeDefined();
      expect(result.exportVersion).toBe('1.0');
    });

    it('should throw NotFoundException for missing agent', async () => {
      agentRepo.findOne.mockResolvedValue(null);

      await expect(service.exportAgent('missing', 'org-1'))
        .rejects.toThrow(NotFoundException);
    });
  });

  // ── estimateCost ──────────────────────────────────────────────────────────

  describe('estimateCost', () => {
    it('should count LLM and tool nodes correctly', async () => {
      const agent = makeAgent({
        pipeline: {
          nodes: [
            { id: 'input_1', type: 'input', config: {} },
            { id: 'llm_1', type: 'llm_call', config: {} },
            { id: 'llm_2', type: 'llm_call', config: {} },
            { id: 'tool_1', type: 'tool_call', config: {}, data: { toolId: 't-1' } },
            { id: 'merge_1', type: 'merge', config: {} },
            { id: 'output_1', type: 'output', config: {} },
          ],
          edges: [
            { id: 'e1', source: 'input_1', target: 'llm_1' },
            { id: 'e2', source: 'input_1', target: 'llm_2' },
            { id: 'e3', source: 'llm_1', target: 'merge_1' },
            { id: 'e4', source: 'llm_2', target: 'merge_1' },
            { id: 'e5', source: 'merge_1', target: 'tool_1' },
            { id: 'e6', source: 'tool_1', target: 'output_1' },
          ],
        },
      });
      agentRepo.findOne.mockResolvedValue(agent);

      const result = await service.estimateCost('agent-1', 'org-1');

      // llm_call x2 + merge x1 = 3 LLM calls
      expect(result.estimatedLlmCalls).toBe(3);
      expect(result.estimatedToolCalls).toBe(1);
      expect(result.nodeCount).toBe(6);
      expect(result.edgeCount).toBe(6);
      expect(result.estimatedCostRange).toBeDefined();
      expect(result.estimatedCostRange.low).toBe(3 * 0.5);
      expect(result.estimatedCostRange.high).toBe(3 * 10);
    });

    it('should detect parallel execution', async () => {
      const agent = makeAgent({
        pipeline: {
          nodes: [
            { id: 'input_1', type: 'input', config: {} },
            { id: 'par_1', type: 'parallel', config: {} },
            { id: 'llm_1', type: 'llm_call', config: {} },
            { id: 'llm_2', type: 'llm_call', config: {} },
            { id: 'merge_1', type: 'merge', config: {} },
            { id: 'output_1', type: 'output', config: {} },
          ],
          edges: [
            { id: 'e1', source: 'input_1', target: 'par_1' },
            { id: 'e2', source: 'par_1', target: 'llm_1' },
            { id: 'e3', source: 'par_1', target: 'llm_2' },
            { id: 'e4', source: 'llm_1', target: 'merge_1' },
            { id: 'e5', source: 'llm_2', target: 'merge_1' },
            { id: 'e6', source: 'merge_1', target: 'output_1' },
          ],
        },
      });
      agentRepo.findOne.mockResolvedValue(agent);

      const result = await service.estimateCost('agent-1', 'org-1');

      expect(result.hasParallelExecution).toBe(true);
    });

    it('should report no parallel execution when there are no parallel nodes', async () => {
      const agent = makeAgent(); // uses makeValidPipeline (no parallel)
      agentRepo.findOne.mockResolvedValue(agent);

      const result = await service.estimateCost('agent-1', 'org-1');

      expect(result.hasParallelExecution).toBe(false);
    });
  });

  // ── getAgents (paginated) ─────────────────────────────────────────────────

  describe('getAgents', () => {
    it('should return paginated results', async () => {
      const agents = [makeAgent()];
      const qb = makeQueryBuilder(agents, 1);
      agentRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.getAgents({ organizationId: 'org-1', page: 1, limit: 20 });

      expect(result.data).toEqual(agents);
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
      expect(result.totalPages).toBe(1);
    });

    it('should apply search filter', async () => {
      const qb = makeQueryBuilder([], 0);
      agentRepo.createQueryBuilder.mockReturnValue(qb);

      await service.getAgents({ organizationId: 'org-1', search: 'chat' });

      expect(qb.andWhere).toHaveBeenCalledWith(
        '(agent.name ILIKE :search OR agent.description ILIKE :search)',
        { search: '%chat%' },
      );
    });

    it('should apply status filter', async () => {
      const qb = makeQueryBuilder([], 0);
      agentRepo.createQueryBuilder.mockReturnValue(qb);

      await service.getAgents({ organizationId: 'org-1', status: AgentStatus.ACTIVE });

      expect(qb.andWhere).toHaveBeenCalledWith('agent.status = :status', { status: AgentStatus.ACTIVE });
    });
  });

  // ── importAgent ───────────────────────────────────────────────────────────

  describe('importAgent', () => {
    it('should reject import data without pipeline', async () => {
      await expect(service.importAgent({}, 'org-1', 'user-1'))
        .rejects.toThrow(BadRequestException);
    });

    it('should create agent from import data with "(Imported)" suffix', async () => {
      const org = makeOrganization();
      const agent = makeAgent({ name: 'My Agent (Imported)' });
      organizationRepo.findOne.mockResolvedValue(org);
      agentRepo.create.mockReturnValue(agent);
      agentRepo.save.mockResolvedValue(agent);

      const importData = {
        name: 'My Agent',
        description: 'Imported agent',
        pipeline: makeValidPipeline(),
        variables: { key: 'val' },
        settings: {},
      };

      const result = await service.importAgent(importData, 'org-1', 'user-1');

      expect(agentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'My Agent (Imported)',
        }),
      );
      expect(result).toBe(agent);
    });
  });

  // ── Version Management ────────────────────────────────────────────────────

  describe('saveVersion', () => {
    it('should save a version snapshot', async () => {
      const agent = makeAgent({ metadata: {} });
      agentRepo.findOne.mockResolvedValue(agent);
      agentRepo.update.mockResolvedValue({ affected: 1 });

      await service.saveVersion('agent-1', 'org-1', 'Initial version');

      expect(agentRepo.update).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({
          metadata: expect.objectContaining({
            versions: expect.arrayContaining([
              expect.objectContaining({
                version: '1.0.0',
                changelog: 'Initial version',
              }),
            ]),
          }),
        }),
      );
    });
  });

  describe('rollbackToVersion', () => {
    it('should rollback to a valid version index', async () => {
      const savedPipeline = makeValidPipeline();
      const agent = makeAgent({
        metadata: {
          versions: [
            { version: '0.9.0', pipeline: savedPipeline, savedAt: new Date().toISOString(), changelog: 'Old' },
          ],
        },
      });
      agentRepo.findOne.mockResolvedValue(agent);
      agentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      const result = await service.rollbackToVersion('agent-1', 'org-1', 0);

      expect(result.pipeline).toEqual(savedPipeline);
      expect(result.version).toBe('0.9.0');
    });

    it('should throw BadRequestException for invalid version index', async () => {
      const agent = makeAgent({ metadata: { versions: [] } });
      agentRepo.findOne.mockResolvedValue(agent);

      await expect(service.rollbackToVersion('agent-1', 'org-1', 5))
        .rejects.toThrow(BadRequestException);
    });
  });

  describe('getVersionHistory', () => {
    it('should return version history from metadata', async () => {
      const versions = [
        { version: '1.0.0', pipeline: makeValidPipeline(), savedAt: '2026-01-01', changelog: 'First' },
      ];
      const agent = makeAgent({ metadata: { versions } });
      agentRepo.findOne.mockResolvedValue(agent);

      const result = await service.getVersionHistory('agent-1', 'org-1');

      expect(result).toEqual(versions);
    });

    it('should return empty array if no versions exist', async () => {
      const agent = makeAgent({ metadata: {} });
      agentRepo.findOne.mockResolvedValue(agent);

      const result = await service.getVersionHistory('agent-1', 'org-1');

      expect(result).toEqual([]);
    });
  });

  // ── getAgentExecutions ────────────────────────────────────────────────────

  describe('getAgentExecutions', () => {
    it('should return paginated execution history', async () => {
      const agent = makeAgent();
      const executions = [{ id: 'exec-1', agentId: 'agent-1' } as any];
      agentRepo.findOne.mockResolvedValue(agent);
      agentExecutionRepo.findAndCount.mockResolvedValue([executions, 1]);

      const result = await service.getAgentExecutions('agent-1', 'org-1', 1, 20);

      expect(result.data).toEqual(executions);
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.totalPages).toBe(1);
    });
  });
});
