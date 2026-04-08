import { Test, TestingModule } from '@nestjs/testing';
import { A2AService } from './a2a.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Tool } from '../../entities/tool.entity';
import { Organization } from '../../entities/organization.entity';
import { User } from '../../entities/user.entity';
import {
  A2AAgent,
  A2AAgentType,
  A2AMessage,
  A2AMessageType,
  A2ASession,
  A2ASessionStatus,
} from './types/a2a.types';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import axios from 'axios';
import { McpSessionService } from './mcp-session.service';
import { ToolExecutorService } from '../tools/tool-executor.service';

// Mock axios - need proper default export structure
jest.mock('axios', () => ({
  __esModule: true,
  default: jest.fn(),
}));
const mockAxios = axios as jest.MockedFunction<typeof axios>;

describe('A2AService - Real Business Logic', () => {
  let service: A2AService;
  let toolRepository: any;
  let organizationRepository: any;
  let userRepository: any;
  let redis: any;
  let mcpSessionService: any;
  let toolExecutorService: any;

  beforeEach(async () => {
    // Reset axios mock
    mockAxios.mockReset();

    // Mock repositories
    toolRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
    };

    organizationRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
    };

    userRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
    };

    // Mock services
    mcpSessionService = {
      create: jest.fn(),
      get: jest.fn(),
      list: jest.fn(),
      update: jest.fn(),
    };

    toolExecutorService = {
      execute: jest.fn(),
      executeTool: jest.fn(),
    };

    // Mock Redis
    redis = {
      get: jest.fn(),
      set: jest.fn(),
      setex: jest.fn(),
      del: jest.fn(),
      keys: jest.fn(),
      llen: jest.fn(),
      lpush: jest.fn(),
      ltrim: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        A2AService,
        {
          provide: getRepositoryToken(Tool),
          useValue: toolRepository,
        },
        {
          provide: getRepositoryToken(Organization),
          useValue: organizationRepository,
        },
        {
          provide: getRepositoryToken(User),
          useValue: userRepository,
        },
        {
          provide: McpSessionService,
          useValue: mcpSessionService,
        },
        {
          provide: ToolExecutorService,
          useValue: toolExecutorService,
        },
        {
          provide: 'default_IORedisModuleConnectionToken',
          useValue: redis,
        },
      ],
    }).compile();

    service = module.get<A2AService>(A2AService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Pure Functions - Request Builders', () => {
    describe('buildOpenAIRequest - Real message transformation', () => {
      it('should transform A2A message to OpenAI format', async () => {
        const config: any = {
          url: '',
          data: {},
          headers: {},
        };

        // Mock tool resolution
        toolRepository.find.mockResolvedValue([
          { name: 'search', toOpenAPITool: () => ({ type: 'function', function: { name: 'search', description: 'Search', parameters: {} } }) },
          { name: 'filter', toOpenAPITool: () => ({ type: 'function', function: { name: 'filter', description: 'Filter', parameters: {} } }) },
        ]);

        const message: A2AMessage = {
          id: 'msg-1',
          fromAgentId: 'agent-1',
          toAgentId: 'agent-2',
          type: A2AMessageType.FUNCTION_CALL,
          content: {
            function: {
              name: 'search',
              arguments: { query: 'test' },
            },
          },
          context: {
            organizationId: 'org-1',
            tools: ['search', 'filter'],
          },
          metadata: {
            timestamp: new Date().toISOString(),
          },
        };

        const result = await service['buildOpenAIRequest'](config, message);

        expect(result.url).toBe('https://api.openai.com/v1/chat/completions');
        expect(result.data.model).toBe('gpt-4o');
        expect(result.data.messages).toHaveLength(1);
        expect(result.data.messages[0].role).toBe('user');
        expect(result.data.tools).toHaveLength(2);
        expect(result.data.tools[0].type).toBe('function');
        expect(result.data.tools[0].function.name).toBe('search');
      });

      it('should handle message without tools', async () => {
        const config: any = { url: '', data: {}, headers: {} };
        const message: A2AMessage = {
          id: 'msg-1',
          fromAgentId: 'agent-1',
          toAgentId: 'agent-2',
          type: A2AMessageType.REQUEST,
          content: { text: 'Hello' },
          context: { organizationId: 'org-1' },
          metadata: { timestamp: new Date().toISOString() },
        };

        toolRepository.find.mockResolvedValue([]);

        const result = await service['buildOpenAIRequest'](config, message);

        expect(result.data.tools).toBeUndefined();
      });
    });

    describe('buildAnthropicRequest - Real message transformation', () => {
      it('should transform A2A message to Anthropic format', async () => {
        const config: any = { url: '', data: {}, headers: {} };

        // Mock tool resolution
        toolRepository.find.mockResolvedValue([
          { name: 'search', toAnthropicTool: () => ({ name: 'search', description: 'Search', input_schema: {} }) },
        ]);

        const message: A2AMessage = {
          id: 'msg-1',
          fromAgentId: 'agent-1',
          toAgentId: 'agent-2',
          type: A2AMessageType.FUNCTION_CALL,
          content: { function: { name: 'search', arguments: { query: 'test' } } },
          context: { organizationId: 'org-1', tools: ['search'] },
          metadata: { timestamp: new Date().toISOString() },
        };

        const result = await service['buildAnthropicRequest'](config, message);

        expect(result.url).toBe('https://api.anthropic.com/v1/messages');
        expect(result.headers['anthropic-version']).toBe('2023-06-01');
        expect(result.data.model).toBe('claude-sonnet-4-20250514');
        expect(result.data.max_tokens).toBe(4096);
        expect(result.data.messages).toHaveLength(1);
        expect(result.data.tools).toHaveLength(1);
        expect(result.data.tools[0].name).toBe('search');
      });
    });

    describe('applyAuthentication - Real auth application', () => {
      it('should apply API key to header', () => {
        const config: any = { headers: {}, params: {} };
        const auth = {
          type: 'api_key',
          location: 'header',
          parameter: 'X-API-Key',
          config: { apiKey: 'test-key-123' },
        };

        service['applyAuthentication'](config, auth);

        expect(config.headers['X-API-Key']).toBe('test-key-123');
      });

      it('should apply API key to query parameter', () => {
        const config: any = { headers: {}, params: {} };
        const auth = {
          type: 'api_key',
          location: 'query',
          parameter: 'api_key',
          config: { apiKey: 'test-key-456' },
        };

        service['applyAuthentication'](config, auth);

        expect(config.params.api_key).toBe('test-key-456');
      });

      it('should apply bearer token', () => {
        const config: any = { headers: {} };
        const auth = {
          type: 'bearer',
          config: { token: 'bearer-token-123' },
        };

        service['applyAuthentication'](config, auth);

        expect(config.headers['Authorization']).toBe('Bearer bearer-token-123');
      });

      it('should apply OAuth2 access token', () => {
        const config: any = { headers: {} };
        const auth = {
          type: 'oauth2',
          config: { accessToken: 'oauth-token-abc' },
        };

        service['applyAuthentication'](config, auth);

        expect(config.headers['Authorization']).toBe('Bearer oauth-token-abc');
      });

      it('should use default parameter when not specified', () => {
        const config: any = { headers: {}, params: {} };
        const authHeader = {
          type: 'api_key',
          location: 'header',
          config: { apiKey: 'key-1' },
        };
        const authQuery = {
          type: 'api_key',
          location: 'query',
          config: { apiKey: 'key-2' },
        };

        service['applyAuthentication'](config, authHeader);
        expect(config.headers['Authorization']).toBe('key-1');

        const config2: any = { headers: {}, params: {} };
        service['applyAuthentication'](config2, authQuery);
        expect(config2.params.api_key).toBe('key-2');
      });
    });

    describe('getDefaultCapabilities - Real configuration by type', () => {
      it('should return OpenAI capabilities', () => {
        const capabilities = service['getDefaultCapabilities'](A2AAgentType.OPENAI);

        expect(capabilities.protocols).toContain('http');
        expect(capabilities.messageFormats).toContain('json');
        expect(capabilities.functions.streaming).toBe(true);
        expect(capabilities.functions.parallel).toBe(true);
        expect(capabilities.memory.contextWindow).toBe(128000);
        expect(capabilities.specializations).toContain('code');
        expect(capabilities.specializations).toContain('reasoning');
      });

      it('should return Anthropic capabilities', () => {
        const capabilities = service['getDefaultCapabilities'](A2AAgentType.ANTHROPIC);

        expect(capabilities.functions.streaming).toBe(true);
        expect(capabilities.functions.chaining).toBe(true);
        expect(capabilities.memory.contextWindow).toBe(200000);
        expect(capabilities.specializations).toContain('reasoning');
        expect(capabilities.specializations).toContain('writing');
      });

      it('should return base capabilities for custom type', () => {
        const capabilities = service['getDefaultCapabilities'](A2AAgentType.CUSTOM_LLM);

        expect(capabilities.protocols).toContain('http');
        expect(capabilities.functions.calling).toBe(true);
        expect(capabilities.functions.streaming).toBe(false);
        expect(capabilities.memory.contextWindow).toBe(4096);
        expect(capabilities.specializations).toBeUndefined();
      });
    });

    describe('getDefaultConfiguration - Real default config', () => {
      it('should return default configuration values', () => {
        const config = service['getDefaultConfiguration']();

        expect(config.timeout).toBe(30000);
        expect(config.retries).toBe(3);
        expect(config.headers['User-Agent']).toBe('almyty-a2a/1.0.0');
      });
    });
  });

  describe('Agent Registration - Real orchestration', () => {
    describe('registerAgent', () => {
      it('should throw when organization does not exist', async () => {
        jest.spyOn(organizationRepository, 'findOne').mockResolvedValue(null);

        await expect(
          service.registerAgent('org-1', {
            name: 'Test Agent',
            type: A2AAgentType.CUSTOM_LLM,
            endpoint: 'https://agents.example.com',
          })
        ).rejects.toThrow(NotFoundException);
      });

      it('should throw when agent connection test fails', async () => {
        const org = { id: 'org-1', name: 'Test Org' } as Partial<Organization> as Organization;
        jest.spyOn(organizationRepository, 'findOne').mockResolvedValue(org);

        // Mock axios to throw connection error
        mockAxios.mockRejectedValue(new Error('Connection refused'));

        await expect(
          service.registerAgent('org-1', {
            name: 'Test Agent',
            type: A2AAgentType.CUSTOM_LLM,
            endpoint: 'http://unreachable:8000',
          })
        ).rejects.toThrow(BadRequestException);
      });

      it('should generate unique agent ID with correct format', async () => {
        const org = { id: 'org-1', name: 'Test Org' } as Partial<Organization> as Organization;
        jest.spyOn(organizationRepository, 'findOne').mockResolvedValue(org);
        mockAxios.mockResolvedValue({ status: 200 });
        redis.setex.mockResolvedValue('OK');

        const agent = await service.registerAgent('org-1', {
          name: 'Test Agent',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'https://agents.example.com',
        });

        // Verify ID format: a2a_{32-hex} (crypto.randomBytes(16).hex).
        // The old Date.now + Math.random shape was guessable.
        expect(agent.id).toMatch(/^a2a_[a-f0-9]{32}$/);
      });

      it('should apply default capabilities based on agent type', async () => {
        const org = { id: 'org-1', name: 'Test Org' } as Partial<Organization> as Organization;
        jest.spyOn(organizationRepository, 'findOne').mockResolvedValue(org);
        mockAxios.mockResolvedValue({ status: 200 });
        redis.setex.mockResolvedValue('OK');

        const agent = await service.registerAgent('org-1', {
          name: 'OpenAI Agent',
          type: A2AAgentType.OPENAI,
          endpoint: 'https://api.openai.com',
        });

        expect(agent.capabilities.memory.contextWindow).toBe(128000);
        expect(agent.capabilities.functions.parallel).toBe(true);
      });

      it('should store agent in Redis with correct TTL', async () => {
        const org = { id: 'org-1', name: 'Test Org' } as Partial<Organization> as Organization;
        jest.spyOn(organizationRepository, 'findOne').mockResolvedValue(org);
        mockAxios.mockResolvedValue({ status: 200 });
        redis.setex.mockResolvedValue('OK');

        const agent = await service.registerAgent('org-1', {
          name: 'Test Agent',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'https://agents.example.com',
        });

        expect(redis.setex).toHaveBeenCalledWith(
          `agent:${agent.id}`,
          86400, // 24 hours TTL
          expect.any(String)
        );
      });

      it('should apply authentication when connecting to agent', async () => {
        const org = { id: 'org-1', name: 'Test Org' } as Partial<Organization> as Organization;
        jest.spyOn(organizationRepository, 'findOne').mockResolvedValue(org);
        mockAxios.mockResolvedValue({ status: 200 });
        redis.setex.mockResolvedValue('OK');

        await service.registerAgent('org-1', {
          name: 'Test Agent',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'https://agents.example.com',
          authentication: {
            type: 'bearer',
            config: { token: 'test-token' },
          },
        });

        // Verify axios was called with auth header
        expect(mockAxios).toHaveBeenCalledWith(
          expect.objectContaining({
            headers: expect.objectContaining({
              Authorization: 'Bearer test-token',
            }),
          })
        );
      });
    });

    describe('updateAgent', () => {
      it('should update agent state and sync to Redis', async () => {
        const agent: A2AAgent = {
          id: 'agent-1',
          name: 'Test Agent',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'https://agents.example.com',
          organizationId: 'org-1',
          isActive: true,
          lastSeen: new Date(),
          capabilities: {} as any,
          configuration: {} as any,
          metadata: {},
        };

        redis.get.mockResolvedValue(JSON.stringify(agent));
        redis.setex.mockResolvedValue('OK');

        await service.updateAgent('agent-1', 'org-1', { isActive: false });

        const updatedAgent = await service.getAgent('agent-1', 'org-1');
        expect(updatedAgent?.isActive).toBe(false);

        // Verify Redis was updated
        expect(redis.setex).toHaveBeenCalledWith(
          'agent:agent-1',
          86400,
          expect.stringContaining('"isActive":false')
        );
      });
    });

    describe('deregisterAgent', () => {
      it('should deactivate agent and remove from Redis', async () => {
        const agent: A2AAgent = {
          id: 'agent-1',
          name: 'Test Agent',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'https://agents.example.com',
          organizationId: 'org-1',
          isActive: true,
          lastSeen: new Date(),
          capabilities: {} as any,
          configuration: {} as any,
          metadata: {},
        };

        // Add agent to in-memory map
        service['agents'].set('agent-1', agent);
        redis.del.mockResolvedValue(1);

        await service.deregisterAgent('agent-1', 'org-1');

        expect(redis.del).toHaveBeenCalledWith('agent:agent-1');

        // Agent should still exist in memory but be inactive
        const deregistered = await service.getAgent('agent-1', 'org-1');
        expect(deregistered).toBeDefined();
        expect(deregistered?.isActive).toBe(false);
      });
    });
  });

  describe('Agent Messaging - Real communication logic', () => {
    describe('sendMessage', () => {
      it('should throw when sender agent not found', async () => {
        redis.get.mockResolvedValue(null);

        await expect(
          service.sendMessage('nonexistent', 'agent-2', { text: 'Hello' }, 'org-1')
        ).rejects.toThrow(NotFoundException);
      });

      it('should throw when agents belong to different organizations', async () => {
        const agent1: A2AAgent = {
          id: 'agent-1',
          name: 'Agent 1',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'https://agent-one.example.com',
          organizationId: 'org-1',
          isActive: true,
          lastSeen: new Date(),
          capabilities: {} as any,
          configuration: {} as any,
          metadata: {},
        };

        const agent2: A2AAgent = {
          id: 'agent-2',
          name: 'Agent 2',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'https://agent-two.example.com',
          organizationId: 'org-2', // Different org!
          isActive: true,
          lastSeen: new Date(),
          capabilities: {} as any,
          configuration: {} as any,
          metadata: {},
        };

        redis.get
          .mockResolvedValueOnce(JSON.stringify(agent1))
          .mockResolvedValueOnce(JSON.stringify(agent2));

        await expect(
          service.sendMessage('agent-1', 'agent-2', { text: 'Hello' }, 'org-1')
        ).rejects.toThrow();
      });

      it('should successfully deliver message between agents in same org', async () => {
        const agent1: A2AAgent = {
          id: 'agent-1',
          name: 'Agent 1',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'https://agent-one.example.com',
          organizationId: 'org-1',
          isActive: true,
          lastSeen: new Date(),
          capabilities: {} as any,
          configuration: {} as any,
          metadata: {},
        };

        const agent2: A2AAgent = {
          id: 'agent-2',
          name: 'Agent 2',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'https://agent-two.example.com',
          organizationId: 'org-1', // Same org
          isActive: true,
          lastSeen: new Date(),
          capabilities: {} as any,
          configuration: {} as any,
          metadata: {},
        };

        redis.get
          .mockResolvedValueOnce(JSON.stringify(agent1))
          .mockResolvedValueOnce(JSON.stringify(agent2));
        redis.lpush.mockResolvedValue(1);
        redis.ltrim.mockResolvedValue('OK');
        mockAxios.mockResolvedValue({ status: 200, data: { success: true } });

        await service.sendMessage('agent-1', 'agent-2', { text: 'Hello' }, 'org-1');

        // Verify HTTP request was made to agent endpoint
        expect(mockAxios).toHaveBeenCalledWith(
          expect.objectContaining({
            url: 'https://agent-two.example.com',
            method: 'POST',
          })
        );
      });
    });
  });

  describe('Session Management - Real orchestration', () => {
    describe('createSession', () => {
      it('should throw when agent does not exist', async () => {
        redis.get.mockResolvedValue(null);

        await expect(
          service.createSession('org-1', ['agent-1', 'agent-2'])
        ).rejects.toThrow(BadRequestException);
      });

      it('should throw when agent belongs to different organization', async () => {
        const agent1: A2AAgent = {
          id: 'agent-1',
          name: 'Agent 1',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'https://agent-one.example.com',
          organizationId: 'org-1',
          isActive: true,
          lastSeen: new Date(),
          capabilities: {} as any,
          configuration: {} as any,
          metadata: {},
        };

        const agent2: A2AAgent = {
          id: 'agent-2',
          name: 'Agent 2',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'https://agent-two.example.com',
          organizationId: 'org-2', // Different org!
          isActive: true,
          lastSeen: new Date(),
          capabilities: {} as any,
          configuration: {} as any,
          metadata: {},
        };

        redis.get
          .mockResolvedValueOnce(JSON.stringify(agent1))
          .mockResolvedValueOnce(JSON.stringify(agent2));

        await expect(
          service.createSession('org-1', ['agent-1', 'agent-2'])
        ).rejects.toThrow(BadRequestException);
      });

      it('should create session with all agents in same org', async () => {
        const agent1: A2AAgent = {
          id: 'agent-1',
          name: 'Agent 1',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'https://agent-one.example.com',
          organizationId: 'org-1',
          isActive: true,
          lastSeen: new Date(),
          capabilities: {} as any,
          configuration: {} as any,
          metadata: {},
        };

        const agent2: A2AAgent = {
          id: 'agent-2',
          name: 'Agent 2',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'https://agent-two.example.com',
          organizationId: 'org-1', // Same org
          isActive: true,
          lastSeen: new Date(),
          capabilities: {} as any,
          configuration: {} as any,
          metadata: {},
        };

        redis.get
          .mockResolvedValueOnce(JSON.stringify(agent1))
          .mockResolvedValueOnce(JSON.stringify(agent2));
        redis.setex.mockResolvedValue('OK');
        redis.lpush.mockResolvedValue(1);
        redis.ltrim.mockResolvedValue('OK');

        const session = await service.createSession('org-1', ['agent-1', 'agent-2']);

        expect(session.organizationId).toBe('org-1');
        expect(session.participantAgents).toEqual(['agent-1', 'agent-2']);
        expect(session.status).toBe(A2ASessionStatus.ACTIVE);
        expect(session.messageCount).toBe(0);
        expect(session.startedAt).toBeDefined();
      });

      it('should store session in Redis with 24h TTL', async () => {
        const agent: A2AAgent = {
          id: 'agent-1',
          name: 'Agent 1',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'https://agent-one.example.com',
          organizationId: 'org-1',
          isActive: true,
          lastSeen: new Date(),
          capabilities: {} as any,
          configuration: {} as any,
          metadata: {},
        };

        redis.get.mockResolvedValue(JSON.stringify(agent));
        redis.setex.mockResolvedValue('OK');
        redis.lpush.mockResolvedValue(1);
        redis.ltrim.mockResolvedValue('OK');

        const session = await service.createSession('org-1', ['agent-1']);

        expect(redis.setex).toHaveBeenCalledWith(
          `session:${session.id}`,
          86400, // 24 hours
          expect.any(String)
        );
      });
    });

    describe('getSession', () => {
      it('should retrieve session from memory first', async () => {
        const agent: A2AAgent = {
          id: 'agent-1',
          name: 'Agent 1',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'https://agent-one.example.com',
          organizationId: 'org-1',
          isActive: true,
          lastSeen: new Date(),
          capabilities: {} as any,
          configuration: {} as any,
          metadata: {},
        };

        redis.get.mockResolvedValue(JSON.stringify(agent));
        redis.setex.mockResolvedValue('OK');
        redis.lpush.mockResolvedValue(1);
        redis.ltrim.mockResolvedValue('OK');

        const session = await service.createSession('org-1', ['agent-1']);
        const retrieved = await service.getSession(session.id);

        expect(retrieved).toBeDefined();
        expect(retrieved?.id).toBe(session.id);
        // Redis.get should not be called for session because it's in memory
        expect(redis.get).not.toHaveBeenCalledWith(`session:${session.id}`);
      });

      it('should fallback to Redis when not in memory', async () => {
        const session: A2ASession = {
          id: 'session-1',
          organizationId: 'org-1',
          participantAgents: ['agent-1'],
          status: A2ASessionStatus.ACTIVE,
          startedAt: new Date(),
          lastActivity: new Date(),
          messageCount: 5,
          metadata: {},
        };

        redis.get.mockResolvedValue(JSON.stringify(session));

        const retrieved = await service.getSession('session-1');

        expect(retrieved).toBeDefined();
        expect(retrieved?.id).toBe('session-1');
        expect(redis.get).toHaveBeenCalledWith('session:session-1');
      });
    });
  });

  describe('Agent Discovery - Real health checking', () => {
    describe('discoverAgents', () => {
      it('should mark unhealthy agents as inactive', async () => {
        const agent1: A2AAgent = {
          id: 'agent-1',
          name: 'Healthy Agent',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'https://agent-one.example.com',
          organizationId: 'org-1',
          isActive: true,
          lastSeen: new Date(),
          capabilities: {} as any,
          configuration: {} as any,
          metadata: {},
        };

        const agent2: A2AAgent = {
          id: 'agent-2',
          name: 'Unhealthy Agent',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'http://unreachable:8002',
          organizationId: 'org-1',
          isActive: true,
          lastSeen: new Date(),
          capabilities: {} as any,
          configuration: {} as any,
          metadata: {},
        };

        // Add agents to in-memory map
        service['agents'].set('agent-1', agent1);
        service['agents'].set('agent-2', agent2);

        redis.setex.mockResolvedValue('OK');

        // Mock health checks: agent1 healthy, agent2 fails
        mockAxios
          .mockResolvedValueOnce({ status: 200 }) // agent1 health OK
          .mockRejectedValueOnce(new Error('Connection refused')); // agent2 fails

        const healthyAgents = await service.discoverAgents('org-1');

        // Only agent1 should be in healthy list
        expect(healthyAgents).toHaveLength(1);
        expect(healthyAgents[0].id).toBe('agent-1');

        // Verify agent2 was marked inactive
        expect(redis.setex).toHaveBeenCalledWith(
          'agent:agent-2',
          86400,
          expect.stringContaining('"isActive":false')
        );
      });
    });
  });

  describe('Workflow Orchestration - Real execution', () => {
    describe('orchestrateAgents', () => {
      it('should create workflow and execute steps', async () => {
        const agent: A2AAgent = {
          id: 'agent-1',
          name: 'Worker Agent',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'https://agent-one.example.com',
          organizationId: 'org-1',
          isActive: true,
          lastSeen: new Date(),
          capabilities: {} as any,
          configuration: {} as any,
          metadata: {},
        };

        redis.get.mockResolvedValue(JSON.stringify(agent));
        redis.lpush.mockResolvedValue(1);
        redis.ltrim.mockResolvedValue('OK');
        mockAxios.mockResolvedValue({ status: 200, data: {} });

        const workflowId = await service.orchestrateAgents('org-1', {
          name: 'Test Workflow',
          description: 'Test workflow description',
          steps: [
            {
              agentId: 'agent-1',
              action: 'process',
              parameters: { input: 'data' },
            },
          ],
        });

        expect(workflowId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

        // Verify message was sent to agent
        expect(mockAxios).toHaveBeenCalledWith(
          expect.objectContaining({
            url: 'https://agent-one.example.com',
            method: 'POST',
          })
        );
      });
    });
  });

  describe('Statistics - Real aggregation', () => {
    describe('getA2AStats', () => {
      it('should calculate stats for organization', async () => {
        const agent1: A2AAgent = {
          id: 'agent-1',
          name: 'Agent 1',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'https://agent-one.example.com',
          organizationId: 'org-1',
          isActive: true,
          lastSeen: new Date(),
          capabilities: {} as any,
          configuration: {} as any,
          metadata: {},
        };

        const agent2: A2AAgent = {
          id: 'agent-2',
          name: 'Agent 2',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'https://agent-two.example.com',
          organizationId: 'org-1',
          isActive: false, // Inactive
          lastSeen: new Date(),
          capabilities: {} as any,
          configuration: {} as any,
          metadata: {},
        };

        // Add agents to in-memory map
        service['agents'].set('agent-1', agent1);
        service['agents'].set('agent-2', agent2);

        redis.keys.mockResolvedValue(['messages:org-1:agent-1']);
        redis.llen.mockResolvedValue(42);

        const stats = await service.getA2AStats('org-1');

        expect(stats.totalAgents).toBe(2);
        expect(stats.activeAgents).toBe(1); // Only agent1
        expect(stats.totalMessages).toBe(42);
      });
    });
  });

  describe('Agent Metrics - Real metrics retrieval', () => {
    describe('getAgentMetrics', () => {
      it('should return metrics from Redis', async () => {
        const metrics = {
          agentId: 'agent-1',
          totalMessages: 100,
          successfulMessages: 95,
          failedMessages: 5,
          averageResponseTime: 250,
          lastActivity: new Date(),
          capabilities: {
            functionsUsed: ['search', 'analyze'],
            toolsUsed: ['tool-1', 'tool-2'],
            workflowsParticipated: ['workflow-1'],
          },
          performance: {
            uptime: 99.5,
            errorRate: 5,
            throughput: 10,
          },
        };

        redis.get.mockResolvedValue(JSON.stringify(metrics));

        const result = await service.getAgentMetrics('agent-1');

        expect(result.totalMessages).toBe(100);
        expect(result.successfulMessages).toBe(95);
        expect(result.averageResponseTime).toBe(250);
      });

      it('should return default metrics when not found', async () => {
        redis.get.mockResolvedValue(null);

        const result = await service.getAgentMetrics('agent-1');

        expect(result.totalMessages).toBe(0);
        expect(result.successfulMessages).toBe(0);
        expect(result.averageResponseTime).toBe(0);
      });
    });
  });

  describe('Agent Cluster - Real cluster creation', () => {
    describe('createAgentCluster', () => {
      it('should create cluster with unique ID', async () => {
        redis.setex.mockResolvedValue('OK');

        const clusterId = await service.createAgentCluster('org-1', {
          name: 'Processing Cluster',
          agentIds: ['agent-1', 'agent-2', 'agent-3'],
          loadBalancing: 'round_robin',
          fallback: true,
        });

        expect(clusterId).toMatch(/^cluster_\d+_[a-z0-9]+$/);
        expect(redis.setex).toHaveBeenCalledWith(
          `cluster:${clusterId}`,
          86400,
          expect.stringContaining('"name":"Processing Cluster"')
        );
      });
    });
  });

  describe('Additional Branch Coverage Tests', () => {
    describe('getAgent with Redis error', () => {
      it('should handle Redis error gracefully when getting agent', async () => {
        redis.get.mockRejectedValue(new Error('Redis connection failed'));

        const result = await service.getAgent('agent-1', 'org-1');

        expect(result).toBeNull();
      });
    });

    describe('getSession with Redis error', () => {
      it('should handle Redis error gracefully when getting session', async () => {
        redis.get.mockRejectedValue(new Error('Redis connection failed'));

        const result = await service.getSession('session-1');

        expect(result).toBeNull();
      });
    });

    describe('updateAgent when agent not found', () => {
      it('should return null when agent does not exist', async () => {
        redis.get.mockResolvedValue(null);

        const result = await service.updateAgent('nonexistent-agent', 'org-1', { isActive: false });

        expect(result).toBeNull();
      });
    });

    describe('deregisterAgent when agent not found', () => {
      it('should return false when agent does not exist', async () => {
        redis.get.mockResolvedValue(null);

        const result = await service.deregisterAgent('nonexistent-agent', 'org-1');

        expect(result).toBe(false);
      });
    });

    describe('deliverMessage error handling', () => {
      it('should handle ECONNREFUSED error and mark agent inactive', async () => {
        const agent: A2AAgent = {
          id: 'agent-1',
          name: 'Test Agent',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'https://agent-one.example.com',
          organizationId: 'org-1',
          isActive: true,
          lastSeen: new Date(),
          capabilities: {} as any,
          configuration: { baseUrl: '', timeout: 5000, retries: 3, headers: {} },
          metadata: {},
        };

        service['agents'].set('agent-1', agent);
        redis.setex.mockResolvedValue('OK');

        const error: any = new Error('Connection refused');
        error.code = 'ECONNREFUSED';
        mockAxios.mockRejectedValue(error);

        const message: A2AMessage = {
          id: 'msg-1',
          fromAgentId: 'agent-0',
          toAgentId: 'agent-1',
          type: A2AMessageType.REQUEST,
          content: { text: 'test' },
          context: { organizationId: 'org-1' },
          metadata: { timestamp: new Date().toISOString() },
        };

        await service['deliverMessage'](message);

        const updatedAgent = await service.getAgent('agent-1', 'org-1');
        expect(updatedAgent?.isActive).toBe(false);
      });

      it('should handle 500 status error and mark agent inactive', async () => {
        const agent: A2AAgent = {
          id: 'agent-1',
          name: 'Test Agent',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'https://agent-one.example.com',
          organizationId: 'org-1',
          isActive: true,
          lastSeen: new Date(),
          capabilities: {} as any,
          configuration: { baseUrl: '', timeout: 5000, retries: 3, headers: {} },
          metadata: {},
        };

        service['agents'].set('agent-1', agent);
        redis.setex.mockResolvedValue('OK');

        const error: any = new Error('Server error');
        error.response = { status: 503 };
        mockAxios.mockRejectedValue(error);

        const message: A2AMessage = {
          id: 'msg-1',
          fromAgentId: 'agent-0',
          toAgentId: 'agent-1',
          type: A2AMessageType.REQUEST,
          content: { text: 'test' },
          context: { organizationId: 'org-1' },
          metadata: { timestamp: new Date().toISOString() },
        };

        await service['deliverMessage'](message);

        const updatedAgent = await service.getAgent('agent-1', 'org-1');
        expect(updatedAgent?.isActive).toBe(false);
      });

      it('should not mark agent inactive for 4xx errors', async () => {
        const agent: A2AAgent = {
          id: 'agent-1',
          name: 'Test Agent',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'https://agent-one.example.com',
          organizationId: 'org-1',
          isActive: true,
          lastSeen: new Date(),
          capabilities: {} as any,
          configuration: { baseUrl: '', timeout: 5000, retries: 3, headers: {} },
          metadata: {},
        };

        service['agents'].set('agent-1', agent);

        const error: any = new Error('Bad request');
        error.response = { status: 400 };
        mockAxios.mockRejectedValue(error);

        const message: A2AMessage = {
          id: 'msg-1',
          fromAgentId: 'agent-0',
          toAgentId: 'agent-1',
          type: A2AMessageType.REQUEST,
          content: { text: 'test' },
          context: { organizationId: 'org-1' },
          metadata: { timestamp: new Date().toISOString() },
        };

        await service['deliverMessage'](message);

        const updatedAgent = await service.getAgent('agent-1', 'org-1');
        expect(updatedAgent?.isActive).toBe(true); // Still active
      });
    });

    describe('buildAgentRequest with different agent types', () => {
      it('should build request for OPENAI agent type', async () => {
        const agent: A2AAgent = {
          id: 'agent-1',
          name: 'OpenAI Agent',
          type: A2AAgentType.OPENAI,
          endpoint: 'https://agent-one.example.com',
          organizationId: 'org-1',
          isActive: true,
          lastSeen: new Date(),
          capabilities: {} as any,
          configuration: { baseUrl: '', timeout: 10000, retries: 3, headers: {} },
          metadata: {},
        };

        const message: A2AMessage = {
          id: 'msg-1',
          fromAgentId: 'agent-0',
          toAgentId: 'agent-1',
          type: A2AMessageType.REQUEST,
          content: { text: 'test' },
          context: { organizationId: 'org-1' },
          metadata: { timestamp: new Date().toISOString() },
        };

        toolRepository.find.mockResolvedValue([]);
        const config = await service['buildAgentRequest'](agent, message);

        expect(config.url).toBe('https://api.openai.com/v1/chat/completions');
        expect(config.data.model).toBe('gpt-4o');
      });

      it('should build request for ANTHROPIC agent type', async () => {
        const agent: A2AAgent = {
          id: 'agent-1',
          name: 'Anthropic Agent',
          type: A2AAgentType.ANTHROPIC,
          endpoint: 'https://agent-one.example.com',
          organizationId: 'org-1',
          isActive: true,
          lastSeen: new Date(),
          capabilities: {} as any,
          configuration: { baseUrl: '', timeout: 10000, retries: 3, headers: {} },
          metadata: {},
        };

        const message: A2AMessage = {
          id: 'msg-1',
          fromAgentId: 'agent-0',
          toAgentId: 'agent-1',
          type: A2AMessageType.REQUEST,
          content: { text: 'test' },
          context: { organizationId: 'org-1' },
          metadata: { timestamp: new Date().toISOString() },
        };

        toolRepository.find.mockResolvedValue([]);
        const config = await service['buildAgentRequest'](agent, message);

        expect(config.url).toBe('https://api.anthropic.com/v1/messages');
        expect(config.headers['anthropic-version']).toBe('2023-06-01');
        expect(config.data.model).toBe('claude-sonnet-4-20250514');
      });

      it('should build request for CUSTOM_LLM agent type', async () => {
        const agent: A2AAgent = {
          id: 'agent-1',
          name: 'Custom Agent',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'https://agent-one.example.com',
          organizationId: 'org-1',
          isActive: true,
          lastSeen: new Date(),
          capabilities: {} as any,
          configuration: { baseUrl: '', timeout: 10000, retries: 3, headers: {} },
          metadata: {},
        };

        const message: A2AMessage = {
          id: 'msg-1',
          fromAgentId: 'agent-0',
          toAgentId: 'agent-1',
          type: A2AMessageType.REQUEST,
          content: { text: 'test' },
          context: { organizationId: 'org-1' },
          metadata: { timestamp: new Date().toISOString() },
        };

        const config = await service['buildAgentRequest'](agent, message);

        expect(config.url).toBe('https://agent-one.example.com');
        expect(config.data).toEqual(message);
      });

      it('should build request with authentication', async () => {
        const agent: A2AAgent = {
          id: 'agent-1',
          name: 'Authenticated Agent',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'https://agent-one.example.com',
          organizationId: 'org-1',
          isActive: true,
          lastSeen: new Date(),
          capabilities: {} as any,
          configuration: { baseUrl: '', timeout: 10000, retries: 3, headers: {} },
          authentication: {
            type: 'bearer',
            location: 'header',
            config: { token: 'test-token-123' },
          },
          metadata: {},
        };

        const message: A2AMessage = {
          id: 'msg-1',
          fromAgentId: 'agent-0',
          toAgentId: 'agent-1',
          type: A2AMessageType.REQUEST,
          content: { text: 'test' },
          context: { organizationId: 'org-1' },
          metadata: { timestamp: new Date().toISOString() },
        };

        const config = await service['buildAgentRequest'](agent, message);

        expect(config.headers['Authorization']).toBe('Bearer test-token-123');
      });
    });

    describe('handleAgentResponse', () => {
      it('should create response message and queue it', async () => {
        const originalMessage: A2AMessage = {
          id: 'msg-1',
          fromAgentId: 'agent-1',
          toAgentId: 'agent-2',
          type: A2AMessageType.REQUEST,
          content: { text: 'test' },
          context: { organizationId: 'org-1' },
          metadata: { timestamp: new Date().toISOString(), correlationId: 'corr-123' },
        };

        const responseData = { result: 'success' };

        let emittedMessage: A2AMessage | null = null;
        service.on('messageReceived', (msg: A2AMessage) => {
          emittedMessage = msg;
        });

        await service['handleAgentResponse'](originalMessage, responseData);

        expect(emittedMessage).toBeDefined();
        expect(emittedMessage?.type).toBe(A2AMessageType.RESPONSE);
        expect(emittedMessage?.fromAgentId).toBe('agent-2');
        expect(emittedMessage?.toAgentId).toBe('agent-1');
        expect(emittedMessage?.content).toEqual({ data: responseData });
        expect(emittedMessage?.context?.parentMessageId).toBe('msg-1');
        expect(emittedMessage?.metadata?.correlationId).toBe('corr-123');
      });
    });

    describe('pingAgent', () => {
      it('should send health check to agent endpoint', async () => {
        const agent: A2AAgent = {
          id: 'agent-1',
          name: 'Test Agent',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'https://agent-one.example.com',
          organizationId: 'org-1',
          isActive: true,
          lastSeen: new Date(),
          capabilities: {} as any,
          configuration: {} as any,
          metadata: {},
        };

        mockAxios.mockResolvedValue({ status: 200 });

        await service['pingAgent'](agent);

        expect(mockAxios).toHaveBeenCalledWith(
          expect.objectContaining({
            url: 'https://agent-one.example.com/health',
            method: 'GET',
            timeout: 5000,
          })
        );
      });

      it('should send health check with authentication', async () => {
        const agent: A2AAgent = {
          id: 'agent-1',
          name: 'Test Agent',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'https://agent-one.example.com',
          organizationId: 'org-1',
          isActive: true,
          lastSeen: new Date(),
          capabilities: {} as any,
          configuration: {} as any,
          authentication: {
            type: 'bearer',
            location: 'header',
            config: { token: 'ping-token' },
          },
          metadata: {},
        };

        mockAxios.mockResolvedValue({ status: 200 });

        await service['pingAgent'](agent);

        expect(mockAxios).toHaveBeenCalledWith(
          expect.objectContaining({
            url: 'https://agent-one.example.com/health',
            headers: expect.objectContaining({
              Authorization: 'Bearer ping-token',
            }),
          })
        );
      });
    });

    describe('registerAgentTool', () => {
      it('should throw when agent not found', async () => {
        redis.get.mockResolvedValue(null);

        await expect(
          service.registerAgentTool('nonexistent-agent', 'org-1', {
            agentId: 'nonexistent-agent',
            toolName: 'search',
            description: 'Search tool',
            inputSchema: { type: 'object', properties: {} },
            outputSchema: { type: 'object', properties: {} },
            endpoint: 'https://agent-one.example.com/search',
            method: 'POST',
          })
        ).rejects.toThrow(NotFoundException);
      });

      it('should register tool for existing agent', async () => {
        const agent: A2AAgent = {
          id: 'agent-1',
          name: 'Test Agent',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'https://agent-one.example.com',
          organizationId: 'org-1',
          isActive: true,
          lastSeen: new Date(),
          capabilities: {} as any,
          configuration: {} as any,
          metadata: {},
        };

        redis.get.mockResolvedValue(JSON.stringify(agent));
        const mockTool = { id: 'tool-1', name: 'Test Agent_search' };
        toolRepository.create.mockReturnValue(mockTool);
        toolRepository.save.mockResolvedValue(mockTool);

        const result = await service.registerAgentTool('agent-1', 'org-1', {
          agentId: 'agent-1',
          toolName: 'search',
          description: 'Search tool',
          inputSchema: { type: 'object', properties: {} },
          outputSchema: { type: 'object', properties: {} },
          endpoint: 'https://agent-one.example.com/search',
          method: 'POST',
        });

        expect(result).toBe(mockTool);
        expect(toolRepository.create).toHaveBeenCalled();
        expect(toolRepository.save).toHaveBeenCalledWith(mockTool);
      });
    });

    describe('executeWorkflow', () => {
      it('should execute workflow steps', async () => {
        const agent: A2AAgent = {
          id: 'agent-1',
          name: 'Worker Agent',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'https://agent-one.example.com',
          organizationId: 'org-1',
          isActive: true,
          lastSeen: new Date(),
          capabilities: {} as any,
          configuration: { baseUrl: '', timeout: 5000, retries: 3, headers: {} },
          metadata: {},
        };

        service['agents'].set('agent-1', agent);
        redis.lpush.mockResolvedValue(1);
        redis.ltrim.mockResolvedValue('OK');
        mockAxios.mockResolvedValue({ status: 200 });

        service['workflows'].set('workflow-1', {
          id: 'workflow-1',
          name: 'Test Workflow',
          organizationId: 'org-1',
          steps: [
            {
              id: 'step-1',
              name: 'process',
              type: 'agent_call',
              agentId: 'agent-1',
              configuration: { input: 'data' },
            },
          ],
          triggers: [
            {
              id: 'manual',
              type: 'manual',
              configuration: {},
              isActive: true,
            },
          ],
          isActive: true,
          metadata: {},
        });

        await service['executeWorkflow']('workflow-1');

        expect(mockAxios).toHaveBeenCalled();
      });

      it('should return early when workflow not found', async () => {
        await service['executeWorkflow']('nonexistent-workflow');

        // Should complete without throwing
        expect(mockAxios).not.toHaveBeenCalled();
      });
    });

    describe('getAgentMetrics with Redis error', () => {
      it('should handle Redis error and return default metrics', async () => {
        redis.get.mockRejectedValue(new Error('Redis error'));

        const result = await service.getAgentMetrics('agent-1');

        expect(result.totalMessages).toBe(0);
        expect(result.agentId).toBe('agent-1');
      });
    });

    describe('updateAgentMetrics', () => {
      it('should increment totalMessages for message_sent event', async () => {
        const existingMetrics = {
          agentId: 'agent-1',
          totalMessages: 10,
          successfulMessages: 8,
          failedMessages: 2,
          averageResponseTime: 100,
          lastActivity: new Date(),
          capabilities: {
            functionsUsed: [],
            toolsUsed: [],
            workflowsParticipated: [],
          },
          performance: {
            uptime: 0,
            errorRate: 0,
            throughput: 0,
          },
        };

        redis.get.mockResolvedValue(JSON.stringify(existingMetrics));
        redis.setex.mockResolvedValue('OK');

        await service['updateAgentMetrics']('agent-1', 'message_sent');

        expect(redis.setex).toHaveBeenCalledWith(
          'metrics:agent:agent-1',
          86400,
          expect.stringContaining('"totalMessages":11')
        );
      });

      it('should increment successfulMessages for message_received event', async () => {
        const existingMetrics = {
          agentId: 'agent-1',
          totalMessages: 10,
          successfulMessages: 8,
          failedMessages: 2,
          averageResponseTime: 100,
          lastActivity: new Date(),
          capabilities: {
            functionsUsed: [],
            toolsUsed: [],
            workflowsParticipated: [],
          },
          performance: {
            uptime: 0,
            errorRate: 0,
            throughput: 0,
          },
        };

        redis.get.mockResolvedValue(JSON.stringify(existingMetrics));
        redis.setex.mockResolvedValue('OK');

        await service['updateAgentMetrics']('agent-1', 'message_received');

        expect(redis.setex).toHaveBeenCalledWith(
          'metrics:agent:agent-1',
          86400,
          expect.stringContaining('"successfulMessages":9')
        );
      });

      it('should handle Redis error gracefully', async () => {
        redis.get.mockRejectedValue(new Error('Redis error'));

        await service['updateAgentMetrics']('agent-1', 'message_sent');

        // Should complete without throwing
      });
    });

    describe('getA2AStats with Redis error', () => {
      it('should handle Redis error and return 0 messages', async () => {
        const agent: A2AAgent = {
          id: 'agent-1',
          name: 'Agent 1',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'https://agent-one.example.com',
          organizationId: 'org-1',
          isActive: true,
          lastSeen: new Date(),
          capabilities: {} as any,
          configuration: {} as any,
          metadata: {},
        };

        service['agents'].set('agent-1', agent);
        redis.keys.mockRejectedValue(new Error('Redis error'));

        const stats = await service.getA2AStats('org-1');

        expect(stats.totalMessages).toBe(0);
        expect(stats.activeAgents).toBe(1);
      });
    });

    describe('shutdown', () => {
      it('should deregister all agents', async () => {
        const agent1: A2AAgent = {
          id: 'agent-1',
          name: 'Agent 1',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'https://agent-one.example.com',
          organizationId: 'org-1',
          isActive: true,
          lastSeen: new Date(),
          capabilities: {} as any,
          configuration: {} as any,
          metadata: {},
        };

        const agent2: A2AAgent = {
          id: 'agent-2',
          name: 'Agent 2',
          type: A2AAgentType.CUSTOM_LLM,
          endpoint: 'https://agent-two.example.com',
          organizationId: 'org-1',
          isActive: true,
          lastSeen: new Date(),
          capabilities: {} as any,
          configuration: {} as any,
          metadata: {},
        };

        service['agents'].set('agent-1', agent1);
        service['agents'].set('agent-2', agent2);
        redis.del.mockResolvedValue(1);
        redis.lpush.mockResolvedValue(1);
        redis.ltrim.mockResolvedValue('OK');

        await service.shutdown();

        expect(redis.del).toHaveBeenCalledWith('agent:agent-1');
        expect(redis.del).toHaveBeenCalledWith('agent:agent-2');
      });
    });

    // ── Regression: agent cross-org scoping + SSRF ────────────────
    describe('Cross-org scoping + SSRF (regression)', () => {
      beforeEach(() => {
        redis.get.mockResolvedValue(null);
      });

      function seedAgent(overrides: Partial<A2AAgent> = {}): A2AAgent {
        const agent: A2AAgent = {
          id: overrides.id || 'agent-victim',
          name: 'Victim',
          type: A2AAgentType.CUSTOM_LLM,
          organizationId: overrides.organizationId || 'victim-org',
          endpoint: 'https://safe.example.com',
          capabilities: {} as any,
          configuration: {} as any,
          isActive: true,
          lastSeen: new Date(),
          ...overrides,
        };
        (service as any).agents.set(agent.id, agent);
        return agent;
      }

      it('getAgent returns null when called from a different org', async () => {
        seedAgent({ id: 'a1', organizationId: 'victim-org' });

        expect(await service.getAgent('a1', 'attacker-org')).toBeNull();
        expect(await service.getAgent('a1', 'victim-org')).not.toBeNull();
      });

      it('updateAgent refuses a cross-org write', async () => {
        seedAgent({ id: 'a1', organizationId: 'victim-org', name: 'Original' });

        const result = await service.updateAgent('a1', 'attacker-org', { name: 'Hijacked' });
        expect(result).toBeNull();

        const intact = await service.getAgent('a1', 'victim-org');
        expect(intact?.name).toBe('Original');
      });

      it('updateAgent strips organizationId and id from the updates bag', async () => {
        seedAgent({ id: 'a1', organizationId: 'victim-org', name: 'Original' });

        await service.updateAgent('a1', 'victim-org', {
          organizationId: 'attacker-org',
          id: 'totally-different',
          name: 'Updated',
        } as any);

        const after = await service.getAgent('a1', 'victim-org');
        expect(after?.organizationId).toBe('victim-org');
        expect(after?.id).toBe('a1');
        expect(after?.name).toBe('Updated');
      });

      it('deregisterAgent refuses a cross-org delete', async () => {
        seedAgent({ id: 'a1', organizationId: 'victim-org' });

        expect(await service.deregisterAgent('a1', 'attacker-org')).toBe(false);

        // Still present.
        const after = (service as any).agents.get('a1');
        expect(after?.isActive).toBe(true);
      });

      it('sendMessage REQUIRES callerOrganizationId (regression — was optional)', async () => {
        const sender = seedAgent({ id: 'a1', organizationId: 'org-1' });
        const recipient = seedAgent({ id: 'a2', organizationId: 'org-1' });

        // Calling with wrong org → rejects.
        await expect(
          service.sendMessage('a1', 'a2', { text: 'hello' }, 'wrong-org'),
        ).rejects.toThrow('cannot send messages as an agent in another organization');
      });

      it.each([
        ['localhost',       'http://localhost:4000'],
        ['127.0.0.1',       'http://127.0.0.1:4000'],
        ['AWS metadata',    'http://169.254.169.254/'],
        ['file://',         'file:///etc/passwd'],
      ])('registerAgent refuses SSRF via endpoint %s', async (_label, endpoint) => {
        const org = { id: 'org-1', name: 'Test Org' } as Organization;
        jest.spyOn(organizationRepository, 'findOne').mockResolvedValue(org);

        await expect(
          service.registerAgent('org-1', {
            name: 'Evil',
            type: A2AAgentType.CUSTOM_LLM,
            endpoint,
          }),
        ).rejects.toThrow(/Refused to (register|reach)/);
      });
    });
  });
});
