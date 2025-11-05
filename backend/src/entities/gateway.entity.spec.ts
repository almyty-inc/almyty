import { Gateway, GatewayStatus, GatewayType } from './gateway.entity';

describe('Gateway Entity', () => {
  let gateway: Gateway;

  beforeEach(() => {
    gateway = new Gateway();
    gateway.id = 'gateway-1';
    gateway.organizationId = 'org-1';
    gateway.name = 'Test Gateway';
    gateway.endpoint = '/api/mcp/test';
    gateway.type = GatewayType.MCP;
    gateway.status = GatewayStatus.ACTIVE;
    gateway.isHealthy = true;
    gateway.configuration = {
      transport: 'http',
      version: '1.0',
    };
    gateway.totalRequests = 100;
    gateway.successfulRequests = 95;
    gateway.lastRequestAt = new Date();
    gateway.lastHealthCheckAt = new Date();
    gateway.createdAt = new Date();
    gateway.updatedAt = new Date();
  });

  describe('isActive', () => {
    it('should return true when status is ACTIVE', () => {
      gateway.status = GatewayStatus.ACTIVE;
      expect(gateway.isActive()).toBe(true);
    });

    it('should return false when status is INACTIVE', () => {
      gateway.status = GatewayStatus.INACTIVE;
      expect(gateway.isActive()).toBe(false);
    });

    it('should return false when status is MAINTENANCE', () => {
      gateway.status = GatewayStatus.MAINTENANCE;
      expect(gateway.isActive()).toBe(false);
    });

    it('should return false when status is ERROR', () => {
      gateway.status = GatewayStatus.ERROR;
      expect(gateway.isActive()).toBe(false);
    });
  });

  describe('canAcceptRequests', () => {
    it('should return true when active and healthy', () => {
      gateway.status = GatewayStatus.ACTIVE;
      gateway.isHealthy = true;
      expect(gateway.canAcceptRequests()).toBe(true);
    });

    it('should return false when active but unhealthy', () => {
      gateway.status = GatewayStatus.ACTIVE;
      gateway.isHealthy = false;
      expect(gateway.canAcceptRequests()).toBe(false);
    });

    it('should return false when inactive but healthy', () => {
      gateway.status = GatewayStatus.INACTIVE;
      gateway.isHealthy = true;
      expect(gateway.canAcceptRequests()).toBe(false);
    });

    it('should return false when inactive and unhealthy', () => {
      gateway.status = GatewayStatus.INACTIVE;
      gateway.isHealthy = false;
      expect(gateway.canAcceptRequests()).toBe(false);
    });
  });

  describe('getSuccessRate', () => {
    it('should calculate success rate correctly', () => {
      gateway.totalRequests = 100;
      gateway.successfulRequests = 95;
      expect(gateway.getSuccessRate()).toBe(95);
    });

    it('should return 0 when no requests', () => {
      gateway.totalRequests = 0;
      gateway.successfulRequests = 0;
      expect(gateway.getSuccessRate()).toBe(0);
    });

    it('should return 100 for all successful requests', () => {
      gateway.totalRequests = 50;
      gateway.successfulRequests = 50;
      expect(gateway.getSuccessRate()).toBe(100);
    });

    it('should return 0 for all failed requests', () => {
      gateway.totalRequests = 50;
      gateway.successfulRequests = 0;
      expect(gateway.getSuccessRate()).toBe(0);
    });

    it('should handle decimal success rates', () => {
      gateway.totalRequests = 3;
      gateway.successfulRequests = 2;
      expect(gateway.getSuccessRate()).toBeCloseTo(66.67, 2);
    });
  });

  describe('incrementRequest', () => {
    it('should increment total and successful requests on success', () => {
      const initialTotal = gateway.totalRequests;
      const initialSuccessful = gateway.successfulRequests;
      const beforeTime = new Date();

      gateway.incrementRequest(true);

      expect(gateway.totalRequests).toBe(initialTotal + 1);
      expect(gateway.successfulRequests).toBe(initialSuccessful + 1);
      expect(gateway.lastRequestAt.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime());
    });

    it('should increment only total requests on failure', () => {
      const initialTotal = gateway.totalRequests;
      const initialSuccessful = gateway.successfulRequests;

      gateway.incrementRequest(false);

      expect(gateway.totalRequests).toBe(initialTotal + 1);
      expect(gateway.successfulRequests).toBe(initialSuccessful);
    });

    it('should increment successful requests by default', () => {
      const initialSuccessful = gateway.successfulRequests;

      gateway.incrementRequest();

      expect(gateway.successfulRequests).toBe(initialSuccessful + 1);
    });

    it('should update lastRequestAt timestamp', () => {
      const beforeTime = new Date();

      gateway.incrementRequest();

      expect(gateway.lastRequestAt).toBeInstanceOf(Date);
      expect(gateway.lastRequestAt.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime());
    });
  });

  describe('updateHealthStatus', () => {
    it('should set isHealthy to true when healthy and status error', () => {
      gateway.isHealthy = false;
      gateway.status = GatewayStatus.ERROR;
      gateway.updateHealthStatus(true);

      expect(gateway.isHealthy).toBe(true);
      expect(gateway.status).toBe(GatewayStatus.ACTIVE);
    });

    it('should set isHealthy to false and change status to error', () => {
      const beforeTime = new Date();
      gateway.isHealthy = true;
      gateway.status = GatewayStatus.ACTIVE;

      gateway.updateHealthStatus(false);

      expect(gateway.isHealthy).toBe(false);
      expect(gateway.status).toBe(GatewayStatus.ERROR);
      expect(gateway.lastHealthCheckAt).toBeInstanceOf(Date);
      expect(gateway.lastHealthCheckAt.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime());
    });

    it('should always update lastHealthCheckAt timestamp', () => {
      const beforeTime = new Date();

      gateway.updateHealthStatus(true);

      expect(gateway.lastHealthCheckAt).toBeInstanceOf(Date);
      expect(gateway.lastHealthCheckAt.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime());
    });

    it('should not change status to active if not error status', () => {
      gateway.status = GatewayStatus.INACTIVE;
      gateway.updateHealthStatus(true);

      expect(gateway.status).toBe(GatewayStatus.INACTIVE);
    });

    it('should not change status to error if not active status', () => {
      gateway.status = GatewayStatus.MAINTENANCE;
      gateway.updateHealthStatus(false);

      expect(gateway.status).toBe(GatewayStatus.MAINTENANCE);
    });
  });

  describe('getActiveTools', () => {
    it('should return active tools', () => {
      gateway.tools = [
        { isActive: true, id: 'tool-1' } as any,
        { isActive: false, id: 'tool-2' } as any,
        { isActive: true, id: 'tool-3' } as any,
      ];

      const activeTools = gateway.getActiveTools();
      expect(activeTools).toHaveLength(2);
      expect(activeTools.every(t => t.isActive)).toBe(true);
    });

    it('should return empty array when no tools', () => {
      gateway.tools = [];
      expect(gateway.getActiveTools()).toEqual([]);
    });

    it('should return empty array when tools is undefined', () => {
      gateway.tools = undefined;
      expect(gateway.getActiveTools()).toEqual([]);
    });

    it('should return empty array when tools is null', () => {
      gateway.tools = null;
      expect(gateway.getActiveTools()).toEqual([]);
    });
  });

  describe('isScoped', () => {
    it('should return true when tools exist', () => {
      gateway.tools = [{ id: 'tool-1' } as any];
      expect(gateway.isScoped()).toBe(true);
    });

    it('should return false when no tools', () => {
      gateway.tools = [];
      expect(gateway.isScoped()).toBe(false);
    });

    it('should return false when tools is undefined', () => {
      gateway.tools = undefined;
      expect(gateway.isScoped()).toBe(false);
    });

    it('should return false when tools is null', () => {
      gateway.tools = null;
      expect(gateway.isScoped()).toBe(false);
    });
  });

  describe('hasRateLimit', () => {
    it('should return true when rate limit is enabled', () => {
      gateway.rateLimitConfig = { enabled: true };
      expect(gateway.hasRateLimit()).toBe(true);
    });

    it('should return false when rate limit is disabled', () => {
      gateway.rateLimitConfig = { enabled: false };
      expect(gateway.hasRateLimit()).toBe(false);
    });

    it('should return false when rateLimitConfig is null', () => {
      gateway.rateLimitConfig = null;
      expect(gateway.hasRateLimit()).toBe(false);
    });

    it('should return false when rateLimitConfig is undefined', () => {
      gateway.rateLimitConfig = undefined;
      expect(gateway.hasRateLimit()).toBe(false);
    });
  });

  describe('getEndpointUrl', () => {
    it('should construct full URL correctly', () => {
      expect(gateway.getEndpointUrl('http://localhost:4000')).toBe('http://localhost:4000/api/mcp/test');
    });

    it('should handle base URL with trailing slash', () => {
      expect(gateway.getEndpointUrl('http://localhost:4000/')).toBe('http://localhost:4000/api/mcp/test');
    });

    it('should handle base URL without protocol', () => {
      expect(gateway.getEndpointUrl('localhost:4000')).toBe('localhost:4000/api/mcp/test');
    });
  });

  describe('supportsProtocol', () => {
    it('should return true for MCP protocols', () => {
      gateway.type = GatewayType.MCP;
      expect(gateway.supportsProtocol('http')).toBe(true);
      expect(gateway.supportsProtocol('sse')).toBe(true);
      expect(gateway.supportsProtocol('websocket')).toBe(true);
    });

    it('should return false for unsupported MCP protocols', () => {
      gateway.type = GatewayType.MCP;
      expect(gateway.supportsProtocol('tcp')).toBe(false);
      expect(gateway.supportsProtocol('grpc')).toBe(false);
    });

    it('should return true for A2A protocols', () => {
      gateway.type = GatewayType.A2A;
      expect(gateway.supportsProtocol('http')).toBe(true);
      expect(gateway.supportsProtocol('grpc')).toBe(true);
    });

    it('should return true for UTCP protocols', () => {
      gateway.type = GatewayType.UTCP;
      expect(gateway.supportsProtocol('http')).toBe(true);
      expect(gateway.supportsProtocol('tcp')).toBe(true);
    });

    it('should return false for unknown gateway type', () => {
      gateway.type = 'UNKNOWN' as any;
      expect(gateway.supportsProtocol('http')).toBe(false);
    });
  });

  describe('getConfigForType', () => {
    it('should return MCP config', () => {
      gateway.type = GatewayType.MCP;
      gateway.configuration = { transport: 'http', version: '1.0' };
      gateway.requestTimeout = 5000;
      gateway.maxRetries = 3;

      const config = gateway.getConfigForType();

      expect(config.type).toBe(GatewayType.MCP);
      expect(config.transport).toBe('http');
      expect(config.version).toBe('1.0');
      expect(config.timeout).toBe(5000);
      expect(config.retries).toBe(3);
    });

    it('should return A2A config', () => {
      gateway.type = GatewayType.A2A;
      gateway.configuration = {
        agentCapabilities: ['chat', 'tools'],
        conversationMemory: true,
      };

      const config = gateway.getConfigForType();

      expect(config.type).toBe(GatewayType.A2A);
      expect(config.agentCapabilities).toEqual(['chat', 'tools']);
      expect(config.conversationMemory).toBe(true);
    });

    it('should return UTCP config', () => {
      gateway.type = GatewayType.UTCP;
      gateway.configuration = {
        protocol: 'http',
        encoding: 'json',
      };

      const config = gateway.getConfigForType();

      expect(config.type).toBe(GatewayType.UTCP);
      expect(config.protocol).toBe('http');
      expect(config.encoding).toBe('json');
    });

    it('should use defaults when configuration properties missing', () => {
      gateway.type = GatewayType.MCP;
      gateway.configuration = {};

      const config = gateway.getConfigForType();

      expect(config.transport).toBe('http');
      expect(config.version).toBe('1.0');
    });

    it('should return base config for unknown type', () => {
      gateway.type = 'UNKNOWN' as any;

      const config = gateway.getConfigForType();

      expect(config.name).toBe(gateway.name);
      expect(config.type).toBe('UNKNOWN');
    });

    it('should handle null tools array', () => {
      gateway.type = GatewayType.MCP;
      gateway.tools = null;

      const config = gateway.getConfigForType();

      expect(config.toolCount).toBe(0);
    });
  });

  describe('incrementRequest - branch coverage', () => {
    it('should increment successful requests when success is true', () => {
      gateway.totalRequests = 10;
      gateway.successfulRequests = 8;

      gateway.incrementRequest(true);

      expect(gateway.totalRequests).toBe(11);
      expect(gateway.successfulRequests).toBe(9);
      expect(gateway.lastRequestAt).toBeDefined();
    });

    it('should not increment successful requests when success is false', () => {
      gateway.totalRequests = 10;
      gateway.successfulRequests = 8;

      gateway.incrementRequest(false);

      expect(gateway.totalRequests).toBe(11);
      expect(gateway.successfulRequests).toBe(8); // Should remain unchanged
      expect(gateway.lastRequestAt).toBeDefined();
    });

    it('should default to success=true when parameter not provided', () => {
      gateway.totalRequests = 10;
      gateway.successfulRequests = 8;

      gateway.incrementRequest();

      expect(gateway.totalRequests).toBe(11);
      expect(gateway.successfulRequests).toBe(9);
    });
  });

  describe('updateHealthStatus - branch coverage', () => {
    it('should change status to ERROR when gateway becomes unhealthy and was ACTIVE', () => {
      gateway.status = GatewayStatus.ACTIVE;

      gateway.updateHealthStatus(false);

      expect(gateway.isHealthy).toBe(false);
      expect(gateway.status).toBe(GatewayStatus.ERROR);
      expect(gateway.lastHealthCheckAt).toBeDefined();
    });

    it('should change status to ACTIVE when gateway becomes healthy and was in ERROR', () => {
      gateway.status = GatewayStatus.ERROR;

      gateway.updateHealthStatus(true);

      expect(gateway.isHealthy).toBe(true);
      expect(gateway.status).toBe(GatewayStatus.ACTIVE);
      expect(gateway.lastHealthCheckAt).toBeDefined();
    });

    it('should not change status when unhealthy but status is not ACTIVE', () => {
      gateway.status = GatewayStatus.INACTIVE;

      gateway.updateHealthStatus(false);

      expect(gateway.isHealthy).toBe(false);
      expect(gateway.status).toBe(GatewayStatus.INACTIVE);
    });

    it('should not change status when healthy but status is not ERROR', () => {
      gateway.status = GatewayStatus.INACTIVE;

      gateway.updateHealthStatus(true);

      expect(gateway.isHealthy).toBe(true);
      expect(gateway.status).toBe(GatewayStatus.INACTIVE);
    });
  });

  describe('getActiveTools - branch coverage', () => {
    it('should return empty array when tools is null', () => {
      gateway.tools = null;

      const activeTools = gateway.getActiveTools();

      expect(activeTools).toEqual([]);
    });

    it('should return empty array when tools is undefined', () => {
      gateway.tools = undefined;

      const activeTools = gateway.getActiveTools();

      expect(activeTools).toEqual([]);
    });
  });

  describe('hasRateLimit - branch coverage', () => {
    it('should return false when rateLimitConfig is null', () => {
      gateway.rateLimitConfig = null;

      const hasLimit = gateway.hasRateLimit();

      expect(hasLimit).toBe(false);
    });

    it('should return false when rateLimitConfig is undefined', () => {
      gateway.rateLimitConfig = undefined;

      const hasLimit = gateway.hasRateLimit();

      expect(hasLimit).toBe(false);
    });

    it('should return false when rateLimitConfig.enabled is false', () => {
      gateway.rateLimitConfig = { enabled: false, requestsPerMinute: 100 };

      const hasLimit = gateway.hasRateLimit();

      expect(hasLimit).toBe(false);
    });
  });

  describe('supportsProtocol - branch coverage', () => {
    it('should support http, sse, websocket for MCP gateways', () => {
      gateway.type = GatewayType.MCP;

      expect(gateway.supportsProtocol('http')).toBe(true);
      expect(gateway.supportsProtocol('sse')).toBe(true);
      expect(gateway.supportsProtocol('websocket')).toBe(true);
      expect(gateway.supportsProtocol('grpc')).toBe(false);
    });

    it('should support http, grpc for A2A gateways', () => {
      gateway.type = GatewayType.A2A;

      expect(gateway.supportsProtocol('http')).toBe(true);
      expect(gateway.supportsProtocol('grpc')).toBe(true);
      expect(gateway.supportsProtocol('sse')).toBe(false);
    });

    it('should support http, tcp for UTCP gateways', () => {
      gateway.type = GatewayType.UTCP;

      expect(gateway.supportsProtocol('http')).toBe(true);
      expect(gateway.supportsProtocol('tcp')).toBe(true);
      expect(gateway.supportsProtocol('websocket')).toBe(false);
    });

    it('should return false for unknown gateway types', () => {
      gateway.type = 'UNKNOWN' as any;

      expect(gateway.supportsProtocol('http')).toBe(false);
      expect(gateway.supportsProtocol('sse')).toBe(false);
    });
  });
});
