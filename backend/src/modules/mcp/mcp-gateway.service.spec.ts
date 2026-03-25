import { Test, TestingModule } from '@nestjs/testing';
import { McpGatewayService, VirtualServer, GatewayPeer } from './mcp-gateway.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Gateway } from '../../entities/gateway.entity';
import { GatewayTool } from '../../entities/gateway-tool.entity';
import { Tool } from '../../entities/tool.entity';
import { Organization } from '../../entities/organization.entity';
import { McpSessionService } from './mcp-session.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import axios from 'axios';

// Mock axios with factory
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn(),
  },
}));

describe('McpGatewayService - Real Business Logic', () => {
  let service: McpGatewayService;
  let gatewayRepository: any;
  let gatewayToolRepository: any;
  let toolRepository: any;
  let organizationRepository: any;
  let mcpSessionService: any;

  beforeEach(async () => {
    // Mock repositories
    gatewayRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
    };

    gatewayToolRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
    };

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

    // Mock MCP session service
    mcpSessionService = {
      broadcastToOrganization: jest.fn().mockResolvedValue(undefined),
      create: jest.fn(),
      get: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        McpGatewayService,
        {
          provide: getRepositoryToken(Gateway),
          useValue: gatewayRepository,
        },
        {
          provide: getRepositoryToken(GatewayTool),
          useValue: gatewayToolRepository,
        },
        {
          provide: getRepositoryToken(Tool),
          useValue: toolRepository,
        },
        {
          provide: getRepositoryToken(Organization),
          useValue: organizationRepository,
        },
        {
          provide: McpSessionService,
          useValue: mcpSessionService,
        },
      ],
    }).compile();

    service = module.get<McpGatewayService>(McpGatewayService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    (axios.get as jest.Mock).mockReset();
    (axios.post as jest.Mock).mockReset();
  });

  describe('Virtual Server Management - Real orchestration', () => {
    describe('createVirtualServer', () => {
      it('should throw when tools are not found', async () => {
        toolRepository.find.mockResolvedValue([]);

        await expect(
          service.createVirtualServer('org-1', {
            name: 'Test Server',
            toolIds: ['tool-1', 'tool-2'],
          })
        ).rejects.toThrow(BadRequestException);
      });

      it('should throw when not all tools belong to organization', async () => {
        const tools = [{ id: 'tool-1', organizationId: 'org-1' }];
        toolRepository.find.mockResolvedValue(tools);

        await expect(
          service.createVirtualServer('org-1', {
            name: 'Test Server',
            toolIds: ['tool-1', 'tool-2'], // Requesting 2, only 1 found
          })
        ).rejects.toThrow('Some tools not found or not accessible');
      });

      it('should generate unique server ID with correct format', async () => {
        const tools = [
          { id: 'tool-1', organizationId: 'org-1' },
          { id: 'tool-2', organizationId: 'org-1' },
        ];
        toolRepository.find.mockResolvedValue(tools);

        const server = await service.createVirtualServer('org-1', {
          name: 'Test Server',
          toolIds: ['tool-1', 'tool-2'],
        });

        // Verify ID format: vs_{timestamp}_{random}
        expect(server.id).toMatch(/^vs_\d+_[a-z0-9]+$/);
      });

      it('should apply default capabilities when not provided', async () => {
        const tools = [{ id: 'tool-1', organizationId: 'org-1' }];
        toolRepository.find.mockResolvedValue(tools);

        const server = await service.createVirtualServer('org-1', {
          name: 'Test Server',
          toolIds: ['tool-1'],
        });

        expect(server.capabilities.tools.listChanged).toBe(true);
        expect(server.capabilities.experimental.almyty.universalApiTranslation).toBe(true);
        expect(server.capabilities.experimental.almyty.virtualServer).toBe(true);
      });

      it('should use custom capabilities when provided', async () => {
        const tools = [{ id: 'tool-1', organizationId: 'org-1' }];
        toolRepository.find.mockResolvedValue(tools);

        const customCapabilities = {
          tools: { listChanged: false },
          resources: {},
          prompts: {},
        };

        const server = await service.createVirtualServer('org-1', {
          name: 'Test Server',
          toolIds: ['tool-1'],
          capabilities: customCapabilities,
        });

        expect(server.capabilities.tools.listChanged).toBe(false);
      });

      it('should generate endpoint path', async () => {
        const tools = [{ id: 'tool-1', organizationId: 'org-1' }];
        toolRepository.find.mockResolvedValue(tools);

        const server = await service.createVirtualServer('org-1', {
          name: 'Test Server',
          toolIds: ['tool-1'],
        });

        expect(server.endpoint).toMatch(/^\/api\/mcp\/servers\/\d+_[a-z0-9]+$/);
      });

      it('should broadcast notification to organization', async () => {
        const tools = [{ id: 'tool-1', organizationId: 'org-1' }];
        toolRepository.find.mockResolvedValue(tools);

        await service.createVirtualServer('org-1', {
          name: 'Test Server',
          toolIds: ['tool-1'],
        });

        expect(mcpSessionService.broadcastToOrganization).toHaveBeenCalledWith(
          'org-1',
          { method: 'notifications/tools/list_changed' }
        );
      });

      it('should store metadata', async () => {
        const tools = [{ id: 'tool-1', organizationId: 'org-1' }];
        toolRepository.find.mockResolvedValue(tools);

        const server = await service.createVirtualServer('org-1', {
          name: 'Test Server',
          description: 'Test Description',
          toolIds: ['tool-1'],
          metadata: { version: '1.0.0', environment: 'test' },
        });

        expect(server.description).toBe('Test Description');
        expect(server.metadata.version).toBe('1.0.0');
        expect(server.metadata.environment).toBe('test');
      });
    });

    describe('getVirtualServer', () => {
      it('should retrieve server from memory', async () => {
        const tools = [{ id: 'tool-1', organizationId: 'org-1' }];
        toolRepository.find.mockResolvedValue(tools);

        const created = await service.createVirtualServer('org-1', {
          name: 'Test Server',
          toolIds: ['tool-1'],
        });

        const retrieved = await service.getVirtualServer(created.id);

        expect(retrieved).toBeDefined();
        expect(retrieved?.id).toBe(created.id);
        expect(retrieved?.name).toBe('Test Server');
      });

      it('should return null for non-existent server', async () => {
        const retrieved = await service.getVirtualServer('nonexistent');

        expect(retrieved).toBeNull();
      });
    });

    describe('listVirtualServers', () => {
      it('should filter servers by organization', async () => {
        const tools1 = [{ id: 'tool-1', organizationId: 'org-1' }];
        const tools2 = [{ id: 'tool-2', organizationId: 'org-2' }];

        toolRepository.find
          .mockResolvedValueOnce(tools1)
          .mockResolvedValueOnce(tools2);

        await service.createVirtualServer('org-1', {
          name: 'Server 1',
          toolIds: ['tool-1'],
        });

        await service.createVirtualServer('org-2', {
          name: 'Server 2',
          toolIds: ['tool-2'],
        });

        const org1Servers = await service.listVirtualServers('org-1');

        expect(org1Servers).toHaveLength(1);
        expect(org1Servers[0].name).toBe('Server 1');
      });

      it('should only return active servers', async () => {
        const tools = [{ id: 'tool-1', organizationId: 'org-1' }];
        toolRepository.find.mockResolvedValue(tools);

        const server = await service.createVirtualServer('org-1', {
          name: 'Server 1',
          toolIds: ['tool-1'],
        });

        // Mark as inactive
        await service.updateVirtualServer(server.id, { isActive: false });

        const activeServers = await service.listVirtualServers('org-1');

        expect(activeServers).toHaveLength(0);
      });
    });

    describe('updateVirtualServer', () => {
      it('should update server properties', async () => {
        const tools = [{ id: 'tool-1', organizationId: 'org-1' }];
        toolRepository.find.mockResolvedValue(tools);

        const server = await service.createVirtualServer('org-1', {
          name: 'Original Name',
          toolIds: ['tool-1'],
        });

        const updated = await service.updateVirtualServer(server.id, {
          name: 'Updated Name',
          description: 'New description',
        });

        expect(updated?.name).toBe('Updated Name');
        expect(updated?.description).toBe('New description');
      });

      it('should return null for non-existent server', async () => {
        const updated = await service.updateVirtualServer('nonexistent', {
          name: 'Test',
        });

        expect(updated).toBeNull();
      });
    });

    describe('deleteVirtualServer', () => {
      it('should delete server and broadcast notification', async () => {
        const tools = [{ id: 'tool-1', organizationId: 'org-1' }];
        toolRepository.find.mockResolvedValue(tools);

        const server = await service.createVirtualServer('org-1', {
          name: 'Test Server',
          toolIds: ['tool-1'],
        });

        const deleted = await service.deleteVirtualServer(server.id);

        expect(deleted).toBe(true);

        const retrieved = await service.getVirtualServer(server.id);
        expect(retrieved).toBeNull();

        // Verify broadcast was called (once for create, once for delete)
        expect(mcpSessionService.broadcastToOrganization).toHaveBeenCalledTimes(2);
      });

      it('should return false for non-existent server', async () => {
        const deleted = await service.deleteVirtualServer('nonexistent');

        expect(deleted).toBe(false);
      });
    });

    describe('getVirtualServerTools', () => {
      it('should throw when server not found', async () => {
        await expect(
          service.getVirtualServerTools('nonexistent')
        ).rejects.toThrow(NotFoundException);
      });

      it('should transform tools to MCP format', async () => {
        const tools = [
          {
            id: 'tool-1',
            name: 'search',
            description: 'Search tool',
            parameters: { type: 'object', properties: { query: { type: 'string' } } },
            organizationId: 'org-1',
          },
        ];
        toolRepository.find.mockResolvedValue(tools);

        const server = await service.createVirtualServer('org-1', {
          name: 'Test Server',
          toolIds: ['tool-1'],
        });

        const mcpTools = await service.getVirtualServerTools(server.id);

        expect(mcpTools).toHaveLength(1);
        expect(mcpTools[0].name).toBe('search');
        expect(mcpTools[0].description).toBe('Search tool');
        expect(mcpTools[0].inputSchema).toEqual({
          type: 'object',
          properties: { query: { type: 'string' } },
        });
      });

      it('should provide default description when missing', async () => {
        const tools = [
          { id: 'tool-1', name: 'search', organizationId: 'org-1' },
        ];
        toolRepository.find.mockResolvedValue(tools);

        const server = await service.createVirtualServer('org-1', {
          name: 'My Server',
          toolIds: ['tool-1'],
        });

        const mcpTools = await service.getVirtualServerTools(server.id);

        expect(mcpTools[0].description).toBe('Tool from virtual server My Server');
      });

      it('should provide default empty schema when missing', async () => {
        const tools = [
          { id: 'tool-1', name: 'search', organizationId: 'org-1' },
        ];
        toolRepository.find.mockResolvedValue(tools);

        const server = await service.createVirtualServer('org-1', {
          name: 'Test Server',
          toolIds: ['tool-1'],
        });

        const mcpTools = await service.getVirtualServerTools(server.id);

        expect(mcpTools[0].inputSchema).toEqual({
          type: 'object',
          properties: {},
        });
      });
    });
  });

  describe('Gateway Peer Federation - Real HTTP operations', () => {
    describe('registerGatewayPeer', () => {
      it('should throw when endpoint is not reachable', async () => {
        (axios.get as jest.Mock).mockRejectedValue(new Error('Connection refused'));

        await expect(
          service.registerGatewayPeer('org-1', {
            name: 'Remote Gateway',
            endpoint: 'http://unreachable:4000',
          })
        ).rejects.toThrow('Cannot connect to peer gateway');
      });

      it('should throw when endpoint is not valid MCP gateway', async () => {
        (axios.get as jest.Mock).mockResolvedValue({
          data: { protocol: 'not-mcp' },
        });

        await expect(
          service.registerGatewayPeer('org-1', {
            name: 'Invalid Gateway',
            endpoint: 'http://invalid:4000',
          })
        ).rejects.toThrow('Endpoint is not a valid MCP gateway');
      });

      it('should successfully register valid peer', async () => {
        (axios.get as jest.Mock).mockResolvedValue({
          data: { protocol: 'mcp', version: '1.0' },
        });

        const peer = await service.registerGatewayPeer('org-1', {
          name: 'Remote Gateway',
          endpoint: 'http://remote:4000',
        });

        expect(peer.id).toMatch(/^peer_\d+_[a-z0-9]+$/);
        expect(peer.name).toBe('Remote Gateway');
        expect(peer.endpoint).toBe('http://remote:4000');
        expect(peer.isActive).toBe(true);
        expect(peer.lastSeen).toBeInstanceOf(Date);
      });

      it('should apply default capabilities when not provided', async () => {
        (axios.get as jest.Mock).mockResolvedValue({
          data: { protocol: 'mcp' },
        });

        const peer = await service.registerGatewayPeer('org-1', {
          name: 'Remote Gateway',
          endpoint: 'http://remote:4000',
        });

        expect(peer.capabilities).toEqual({
          tools: {},
          resources: {},
          prompts: {},
        });
      });

      it('should use custom capabilities when provided', async () => {
        (axios.get as jest.Mock).mockResolvedValue({
          data: { protocol: 'mcp' },
        });

        const customCapabilities = {
          tools: { listChanged: true },
          resources: {},
          prompts: {},
        };

        const peer = await service.registerGatewayPeer('org-1', {
          name: 'Remote Gateway',
          endpoint: 'http://remote:4000',
          capabilities: customCapabilities,
        });

        expect(peer.capabilities.tools.listChanged).toBe(true);
      });
    });

    describe('listGatewayPeers', () => {
      it('should filter peers by organization', async () => {
        (axios.get as jest.Mock).mockResolvedValue({
          data: { protocol: 'mcp' },
        });

        await service.registerGatewayPeer('org-1', {
          name: 'Peer 1',
          endpoint: 'http://peer1:4000',
        });

        await service.registerGatewayPeer('org-2', {
          name: 'Peer 2',
          endpoint: 'http://peer2:4000',
        });

        const org1Peers = await service.listGatewayPeers('org-1');

        expect(org1Peers).toHaveLength(1);
        expect(org1Peers[0].name).toBe('Peer 1');
      });

      it('should only return active peers', async () => {
        (axios.get as jest.Mock).mockResolvedValue({
          data: { protocol: 'mcp' },
        });

        const peer = await service.registerGatewayPeer('org-1', {
          name: 'Peer 1',
          endpoint: 'http://peer1:4000',
        });

        // Manually mark as inactive
        peer.isActive = false;

        const activePeers = await service.listGatewayPeers('org-1');

        expect(activePeers).toHaveLength(0);
      });
    });

    describe('removeGatewayPeer', () => {
      it('should remove peer and return true', async () => {
        (axios.get as jest.Mock).mockResolvedValue({
          data: { protocol: 'mcp' },
        });

        const peer = await service.registerGatewayPeer('org-1', {
          name: 'Peer 1',
          endpoint: 'http://peer1:4000',
        });

        const removed = await service.removeGatewayPeer(peer.id);

        expect(removed).toBe(true);

        const peers = await service.listGatewayPeers('org-1');
        expect(peers).toHaveLength(0);
      });

      it('should return false for non-existent peer', async () => {
        const removed = await service.removeGatewayPeer('nonexistent');

        expect(removed).toBe(false);
      });
    });

    describe('forwardToPeer', () => {
      it('should throw when peer not found', async () => {
        await expect(
          service.forwardToPeer('nonexistent', 'tools/list', {})
        ).rejects.toThrow(NotFoundException);
      });

      it('should forward request and update lastSeen', async () => {
        (axios.get as jest.Mock).mockResolvedValue({
          data: { protocol: 'mcp' },
        });
        (axios.post as jest.Mock).mockResolvedValue({
          data: { jsonrpc: '2.0', id: 1, result: { tools: [] } },
        });

        const peer = await service.registerGatewayPeer('org-1', {
          name: 'Remote Gateway',
          endpoint: 'http://remote:4000',
        });

        const originalLastSeen = peer.lastSeen;

        // Wait a bit to ensure timestamp difference
        await new Promise(resolve => setTimeout(resolve, 10));

        const result = await service.forwardToPeer(peer.id, 'tools/list', {});

        expect(result).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
        expect((axios.post as jest.Mock)).toHaveBeenCalledWith(
          'http://remote:4000/mcp',
          expect.objectContaining({
            jsonrpc: '2.0',
            method: 'tools/list',
            params: {},
          }),
          expect.objectContaining({
            timeout: 30000,
          })
        );

        const updatedPeer = await service.listGatewayPeers('org-1');
        expect(updatedPeer[0].lastSeen.getTime()).toBeGreaterThan(originalLastSeen.getTime());
      });

      it('should mark peer inactive on connection error', async () => {
        (axios.get as jest.Mock).mockResolvedValue({
          data: { protocol: 'mcp' },
        });

        const peer = await service.registerGatewayPeer('org-1', {
          name: 'Remote Gateway',
          endpoint: 'http://remote:4000',
        });

        (axios.post as jest.Mock).mockRejectedValue({ code: 'ECONNREFUSED', message: 'Connection refused' });

        await expect(
          service.forwardToPeer(peer.id, 'tools/list', {})
        ).rejects.toThrow('Peer gateway request failed');

        expect(peer.isActive).toBe(false);
      });

      it('should mark peer inactive on 500 error', async () => {
        (axios.get as jest.Mock).mockResolvedValue({
          data: { protocol: 'mcp' },
        });

        const peer = await service.registerGatewayPeer('org-1', {
          name: 'Remote Gateway',
          endpoint: 'http://remote:4000',
        });

        (axios.post as jest.Mock).mockRejectedValue({
          response: { status: 500 },
          message: 'Internal Server Error',
        });

        await expect(
          service.forwardToPeer(peer.id, 'tools/list', {})
        ).rejects.toThrow('Peer gateway request failed');

        expect(peer.isActive).toBe(false);
      });
    });
  });

  describe('Server Composition - Real aggregation', () => {
    describe('getComposedTools', () => {
      it('should aggregate tools from virtual servers and peers', async () => {
        // Create virtual server
        const tools = [
          { id: 'tool-1', name: 'local_search', description: 'Local search', organizationId: 'org-1' },
        ];
        toolRepository.find.mockResolvedValue(tools);

        await service.createVirtualServer('org-1', {
          name: 'Local Server',
          toolIds: ['tool-1'],
        });

        // Register peer
        (axios.get as jest.Mock).mockResolvedValue({
          data: { protocol: 'mcp' },
        });
        (axios.post as jest.Mock).mockResolvedValue({
          data: {
            result: {
              tools: [{ name: 'remote_search', description: 'Remote search' }],
            },
          },
        });

        await service.registerGatewayPeer('org-1', {
          name: 'Remote Gateway',
          endpoint: 'http://remote:4000',
        });

        const composedTools = await service.getComposedTools('org-1');

        expect(composedTools).toHaveLength(2);
        expect(composedTools[0].name).toBe('local_search');
        expect(composedTools[1].name).toBe('Remote Gateway:remote_search');
        expect(composedTools[1].description).toContain('(from Remote Gateway)');
      });

      it('should continue on peer error', async () => {
        // Create virtual server
        const tools = [
          { id: 'tool-1', name: 'local_search', organizationId: 'org-1' },
        ];
        toolRepository.find.mockResolvedValue(tools);

        await service.createVirtualServer('org-1', {
          name: 'Local Server',
          toolIds: ['tool-1'],
        });

        // Register peer that will fail
        (axios.get as jest.Mock).mockResolvedValue({
          data: { protocol: 'mcp' },
        });
        (axios.post as jest.Mock).mockRejectedValue(new Error('Connection failed'));

        await service.registerGatewayPeer('org-1', {
          name: 'Failing Peer',
          endpoint: 'http://failing:4000',
        });

        // Should still return local tools
        const composedTools = await service.getComposedTools('org-1');

        expect(composedTools).toHaveLength(1);
        expect(composedTools[0].name).toBe('local_search');
      });
    });
  });

  describe('Health Monitoring - Real health checking', () => {
    describe('checkPeerHealth', () => {
      it('should check health of all peers', async () => {
        (axios.get as jest.Mock)
          .mockResolvedValueOnce({ data: { protocol: 'mcp' } }) // Register peer 1
          .mockResolvedValueOnce({ data: { protocol: 'mcp' } }) // Register peer 2
          .mockResolvedValueOnce({ status: 200 }) // Health check peer 1
          .mockRejectedValueOnce(new Error('Timeout')); // Health check peer 2 fails

        await service.registerGatewayPeer('org-1', {
          name: 'Healthy Peer',
          endpoint: 'http://healthy:4000',
        });

        await service.registerGatewayPeer('org-1', {
          name: 'Unhealthy Peer',
          endpoint: 'http://unhealthy:4000',
        });

        const health = await service.checkPeerHealth();

        expect(health.total).toBe(2);
        expect(health.healthy).toBe(1);
        expect(health.unhealthy).toBe(1);
        expect(health.peers).toHaveLength(2);
        expect(health.peers[0].isHealthy).toBe(true);
        expect(health.peers[0].responseTime).toBeGreaterThanOrEqual(0);
        expect(health.peers[1].isHealthy).toBe(false);
        expect(health.peers[1].responseTime).toBeUndefined();
      });

      it('should update peer active status based on health', async () => {
        (axios.get as jest.Mock)
          .mockResolvedValueOnce({ data: { protocol: 'mcp' } })
          .mockRejectedValueOnce(new Error('Connection failed'));

        const peer = await service.registerGatewayPeer('org-1', {
          name: 'Test Peer',
          endpoint: 'http://test:4000',
        });

        expect(peer.isActive).toBe(true);

        await service.checkPeerHealth();

        expect(peer.isActive).toBe(false);
      });
    });
  });
});
