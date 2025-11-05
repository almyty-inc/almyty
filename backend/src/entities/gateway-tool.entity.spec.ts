import { GatewayTool } from './gateway-tool.entity';
import { Tool } from './tool.entity';

describe('GatewayTool Entity', () => {
  let gatewayTool: GatewayTool;
  let mockTool: Partial<Tool>;

  beforeEach(() => {
    mockTool = {
      name: 'TestTool',
      description: 'Test tool description',
      parameters: { param1: 'string', param2: 'number' },
      configuration: {
        timeout: 5000,
        retries: 2,
        cache: { enabled: true, ttl: 600 },
      },
      canExecute: jest.fn().mockReturnValue(true),
    };

    gatewayTool = new GatewayTool();
    gatewayTool.id = 'gt-1';
    gatewayTool.gatewayId = 'gw-1';
    gatewayTool.toolId = 'tool-1';
    gatewayTool.isActive = true;
    gatewayTool.tool = mockTool as Tool;
    gatewayTool.usageCount = 0;
  });

  describe('getEffectiveName', () => {
    it('should return override name when available', () => {
      gatewayTool.overrides = { name: 'OverriddenName' };

      expect(gatewayTool.getEffectiveName()).toBe('OverriddenName');
    });

    it('should return tool name when no override', () => {
      expect(gatewayTool.getEffectiveName()).toBe('TestTool');
    });

    it('should return unknown when no tool and no override', () => {
      gatewayTool.tool = null;

      expect(gatewayTool.getEffectiveName()).toBe('unknown');
    });
  });

  describe('getEffectiveDescription', () => {
    it('should return override description when available', () => {
      gatewayTool.overrides = { description: 'Overridden description' };

      expect(gatewayTool.getEffectiveDescription()).toBe('Overridden description');
    });

    it('should return tool description when no override', () => {
      expect(gatewayTool.getEffectiveDescription()).toBe('Test tool description');
    });

    it('should return empty string when no tool and no override', () => {
      gatewayTool.tool = null;

      expect(gatewayTool.getEffectiveDescription()).toBe('');
    });
  });

  describe('getEffectiveParameters', () => {
    it('should return tool parameters when no override', () => {
      const params = gatewayTool.getEffectiveParameters();

      expect(params).toEqual({ param1: 'string', param2: 'number' });
    });

    it('should merge tool parameters with overrides', () => {
      gatewayTool.overrides = {
        parameters: { param2: 'string', param3: 'boolean' },
      };

      const params = gatewayTool.getEffectiveParameters();

      expect(params).toEqual({
        param1: 'string',
        param2: 'string',
        param3: 'boolean',
      });
    });

    it('should return override parameters when tool has no parameters', () => {
      gatewayTool.tool.parameters = undefined;
      gatewayTool.overrides = { parameters: { newParam: 'string' } };

      const params = gatewayTool.getEffectiveParameters();

      expect(params).toEqual({ newParam: 'string' });
    });

    it('should return empty object when no tool and no override', () => {
      gatewayTool.tool = null;

      expect(gatewayTool.getEffectiveParameters()).toEqual({});
    });
  });

  describe('hasPermission', () => {
    it('should return true when no permissions configured', () => {
      const result = gatewayTool.hasPermission('user-1', ['admin'], 'org-1', ['read']);

      expect(result).toBe(true);
    });

    it('should return false when user not in allowedUsers', () => {
      gatewayTool.permissions = { allowedUsers: ['user-2', 'user-3'] };

      const result = gatewayTool.hasPermission('user-1', ['admin'], 'org-1', ['read']);

      expect(result).toBe(false);
    });

    it('should return true when user in allowedUsers', () => {
      gatewayTool.permissions = { allowedUsers: ['user-1', 'user-2'] };

      const result = gatewayTool.hasPermission('user-1', ['admin'], 'org-1', ['read']);

      expect(result).toBe(true);
    });

    it('should return false when user has no required role', () => {
      gatewayTool.permissions = { allowedRoles: ['superadmin', 'owner'] };

      const result = gatewayTool.hasPermission('user-1', ['admin', 'member'], 'org-1', ['read']);

      expect(result).toBe(false);
    });

    it('should return true when user has required role', () => {
      gatewayTool.permissions = { allowedRoles: ['admin', 'owner'] };

      const result = gatewayTool.hasPermission('user-1', ['admin', 'member'], 'org-1', ['read']);

      expect(result).toBe(true);
    });

    it('should return false when org not in allowedOrganizations', () => {
      gatewayTool.permissions = { allowedOrganizations: ['org-2', 'org-3'] };

      const result = gatewayTool.hasPermission('user-1', ['admin'], 'org-1', ['read']);

      expect(result).toBe(false);
    });

    it('should return true when org in allowedOrganizations', () => {
      gatewayTool.permissions = { allowedOrganizations: ['org-1', 'org-2'] };

      const result = gatewayTool.hasPermission('user-1', ['admin'], 'org-1', ['read']);

      expect(result).toBe(true);
    });

    it('should return false when user lacks required scope', () => {
      gatewayTool.permissions = { requiredScopes: ['write', 'admin'] };

      const result = gatewayTool.hasPermission('user-1', ['admin'], 'org-1', ['read']);

      expect(result).toBe(false);
    });

    it('should return true when user has required scope', () => {
      gatewayTool.permissions = { requiredScopes: ['write', 'admin'] };

      const result = gatewayTool.hasPermission('user-1', ['admin'], 'org-1', ['write', 'read']);

      expect(result).toBe(true);
    });

    it('should check all permission types together', () => {
      gatewayTool.permissions = {
        allowedUsers: ['user-1'],
        allowedRoles: ['admin'],
        allowedOrganizations: ['org-1'],
        requiredScopes: ['write'],
      };

      expect(gatewayTool.hasPermission('user-1', ['admin'], 'org-1', ['write'])).toBe(true);
      expect(gatewayTool.hasPermission('user-2', ['admin'], 'org-1', ['write'])).toBe(false);
      expect(gatewayTool.hasPermission('user-1', ['member'], 'org-1', ['write'])).toBe(false);
      expect(gatewayTool.hasPermission('user-1', ['admin'], 'org-2', ['write'])).toBe(false);
      expect(gatewayTool.hasPermission('user-1', ['admin'], 'org-1', ['read'])).toBe(false);
    });
  });

  describe('transformInput', () => {
    it('should return input unchanged when no transformations', () => {
      const input = { key1: 'value1', key2: 'value2' };

      const result = gatewayTool.transformInput(input);

      expect(result).toEqual({ key1: 'value1', key2: 'value2' });
    });

    it('should map input keys according to inputMapping', () => {
      gatewayTool.transformations = {
        inputMapping: { oldKey: 'newKey' },
      };
      const input = { oldKey: 'value', other: 'data' };

      const result = gatewayTool.transformInput(input);

      expect(result).toEqual({ newKey: 'value', other: 'data' });
      expect(result).not.toHaveProperty('oldKey');
    });

    it('should handle multiple key mappings', () => {
      gatewayTool.transformations = {
        inputMapping: { key1: 'mapped1', key2: 'mapped2' },
      };
      const input = { key1: 'val1', key2: 'val2', key3: 'val3' };

      const result = gatewayTool.transformInput(input);

      expect(result).toEqual({ mapped1: 'val1', mapped2: 'val2', key3: 'val3' });
    });

    it('should not delete source key when mapping to same key', () => {
      gatewayTool.transformations = {
        inputMapping: { sameKey: 'sameKey' },
      };
      const input = { sameKey: 'value' };

      const result = gatewayTool.transformInput(input);

      expect(result).toEqual({ sameKey: 'value' });
    });
  });

  describe('transformOutput', () => {
    it('should return output unchanged when no transformations', () => {
      const output = { result: 'data' };

      const result = gatewayTool.transformOutput(output);

      expect(result).toEqual({ result: 'data' });
    });

    it('should map output keys according to outputMapping', () => {
      gatewayTool.transformations = {
        outputMapping: { internalKey: 'externalKey' },
      };
      const output = { internalKey: 'value', other: 'data' };

      const result = gatewayTool.transformOutput(output);

      expect(result).toEqual({ externalKey: 'value', other: 'data' });
      expect(result).not.toHaveProperty('internalKey');
    });

    it('should handle non-object output', () => {
      gatewayTool.transformations = {
        outputMapping: { key: 'newKey' },
      };

      expect(gatewayTool.transformOutput('string')).toBe('string');
      expect(gatewayTool.transformOutput(123)).toBe(123);
      expect(gatewayTool.transformOutput(null)).toBe(null);
    });

    it('should handle arrays as output', () => {
      gatewayTool.transformations = {
        outputMapping: { '0': 'first' },
      };
      const output = [1, 2, 3];

      const result = gatewayTool.transformOutput(output);

      // Arrays get converted to objects when spread
      expect(result).toEqual({ first: 1, '1': 2, '2': 3 });
    });
  });

  describe('getEffectiveTimeout', () => {
    it('should return override timeout when available', () => {
      gatewayTool.overrides = { timeout: 10000 };

      expect(gatewayTool.getEffectiveTimeout()).toBe(10000);
    });

    it('should return tool timeout when no override', () => {
      expect(gatewayTool.getEffectiveTimeout()).toBe(5000);
    });

    it('should return default timeout when no tool config and no override', () => {
      gatewayTool.tool.configuration = undefined;

      expect(gatewayTool.getEffectiveTimeout()).toBe(30000);
    });
  });

  describe('getEffectiveRetries', () => {
    it('should return override retries when available', () => {
      gatewayTool.overrides = { retries: 5 };

      expect(gatewayTool.getEffectiveRetries()).toBe(5);
    });

    it('should return tool retries when no override', () => {
      expect(gatewayTool.getEffectiveRetries()).toBe(2);
    });

    it('should return default retries when no tool config and no override', () => {
      gatewayTool.tool.configuration = undefined;

      expect(gatewayTool.getEffectiveRetries()).toBe(3);
    });
  });

  describe('incrementUsage', () => {
    it('should increment usage count', () => {
      const initialCount = gatewayTool.usageCount;

      gatewayTool.incrementUsage();

      expect(gatewayTool.usageCount).toBe(initialCount + 1);
    });

    it('should update lastUsedAt timestamp', () => {
      const beforeTime = Date.now();

      gatewayTool.incrementUsage();

      const afterTime = Date.now();
      expect(gatewayTool.lastUsedAt.getTime()).toBeGreaterThanOrEqual(beforeTime);
      expect(gatewayTool.lastUsedAt.getTime()).toBeLessThanOrEqual(afterTime);
    });

    it('should increment on multiple calls', () => {
      gatewayTool.usageCount = 5;

      gatewayTool.incrementUsage();
      gatewayTool.incrementUsage();
      gatewayTool.incrementUsage();

      expect(gatewayTool.usageCount).toBe(8);
    });
  });

  describe('canExecute', () => {
    it('should return true when active and tool can execute', () => {
      expect(gatewayTool.canExecute()).toBe(true);
    });

    it('should return false when not active', () => {
      gatewayTool.isActive = false;

      expect(gatewayTool.canExecute()).toBe(false);
    });

    it('should return false when tool cannot execute', () => {
      (gatewayTool.tool.canExecute as jest.Mock).mockReturnValue(false);

      expect(gatewayTool.canExecute()).toBe(false);
    });

    it('should return falsy when tool is null', () => {
      gatewayTool.tool = null;

      expect(gatewayTool.canExecute()).toBeFalsy();
    });
  });

  describe('getCacheConfig', () => {
    it('should return tool cache config when no override', () => {
      const config = gatewayTool.getCacheConfig();

      expect(config).toEqual({ enabled: true, ttl: 600 });
    });

    it('should return override cache config', () => {
      gatewayTool.overrides = {
        cache: { enabled: false, ttl: 120 },
      };

      const config = gatewayTool.getCacheConfig();

      expect(config).toEqual({ enabled: false, ttl: 120 });
    });

    it('should merge enabled from override and ttl from tool', () => {
      gatewayTool.overrides = {
        cache: { enabled: false },
      };

      const config = gatewayTool.getCacheConfig();

      expect(config).toEqual({ enabled: false, ttl: 600 });
    });

    it('should merge ttl from override and enabled from tool', () => {
      gatewayTool.overrides = {
        cache: { enabled: true, ttl: 1200 },
      };

      const config = gatewayTool.getCacheConfig();

      expect(config).toEqual({ enabled: true, ttl: 1200 });
    });

    it('should return default config when no tool config and no override', () => {
      gatewayTool.tool.configuration = undefined;

      const config = gatewayTool.getCacheConfig();

      expect(config).toEqual({ enabled: false, ttl: 300 });
    });
  });
});
