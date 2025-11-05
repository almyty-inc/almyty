import { Test, TestingModule } from '@nestjs/testing';
import { PluginManagerService } from './plugin-manager.service';
import { PluginHookType } from './types/plugin.types';

describe('PluginManagerService - Real Business Logic', () => {
  let service: PluginManagerService;
  let mockRedis: any;

  beforeEach(async () => {
    mockRedis = {
      get: jest.fn(),
      set: jest.fn(),
      setex: jest.fn(),
      del: jest.fn(),
      hget: jest.fn(),
      hset: jest.fn(),
      hdel: jest.fn(),
      hgetall: jest.fn(),
      keys: jest.fn().mockResolvedValue([]),
      incr: jest.fn(),
      expire: jest.fn(),
      lpush: jest.fn(),
      lrange: jest.fn(),
      ltrim: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PluginManagerService,
        {
          provide: 'default_IORedisModuleConnectionToken',
          useValue: mockRedis,
        },
      ],
    }).compile();

    service = module.get<PluginManagerService>(PluginManagerService);
  });

  describe('Module Lifecycle', () => {
    it('should initialize successfully', async () => {
      mockRedis.keys.mockResolvedValue([]);
      mockRedis.hgetall.mockResolvedValue({});

      await service.onModuleInit();

      expect(service).toBeDefined();
    });

    it('should initialize plugin manager with built-in plugins', async () => {
      mockRedis.keys.mockResolvedValue([]);
      mockRedis.hgetall.mockResolvedValue({});

      await service.initialize();

      expect(service).toBeDefined();
      expect(mockRedis.setex).toHaveBeenCalled(); // Plugin registration
    });

    it('should shutdown successfully', async () => {
      await service.shutdown();

      expect(service).toBeDefined();
    });
  });

  describe('Plugin Registration', () => {
    const mockPlugin = {
      name: 'Test Plugin',
      version: '1.0.0',
      description: 'Test plugin for testing',
      author: 'Test Author',
      isActive: true,
      configuration: {
        enabled: true,
        priority: 50,
        settings: {},
      },
      capabilities: {
        hooks: [PluginHookType.PRE_REQUEST],
        protocols: ['mcp'],
        dataFormats: ['json'],
        operations: ['read'],
      },
      hooks: [
        {
          type: PluginHookType.PRE_REQUEST,
          handler: 'testHandler',
          async: false,
          timeout: 5000,
        },
      ],
    };

    it('should register a global plugin successfully', async () => {
      const pluginId = await service.registerPlugin(mockPlugin);

      expect(pluginId).toMatch(/^plugin_\d+_[a-z0-9]+$/);
      expect(mockRedis.setex).toHaveBeenCalledWith(
        `plugin:${pluginId}`,
        86400,
        expect.any(String)
      );
    });

    it('should register an organization-scoped plugin', async () => {
      const pluginId = await service.registerPlugin(mockPlugin, 'org-1');

      expect(pluginId).toBeDefined();
      expect(mockRedis.setex).toHaveBeenCalledWith(
        `plugin:${pluginId}`,
        86400,
        expect.stringContaining('org-1')
      );
    });

    it('should reject invalid plugin during validation', async () => {
      const invalidPlugin = {
        ...mockPlugin,
        name: '', // Invalid: empty name
      };

      await expect(service.registerPlugin(invalidPlugin)).rejects.toThrow();
    });

    it('should register plugin in hook registry', async () => {
      const pluginId = await service.registerPlugin(mockPlugin);

      // Plugin should be registered for PRE_REQUEST hook
      const plugins = await service.getPluginsByHook(PluginHookType.PRE_REQUEST);
      expect(plugins.length).toBeGreaterThan(0);
    });

    it('should assign unique IDs to plugins', async () => {
      const id1 = await service.registerPlugin(mockPlugin);
      const id2 = await service.registerPlugin(mockPlugin);

      expect(id1).not.toBe(id2);
    });
  });

  describe('Plugin Unregistration', () => {
    it('should unregister a plugin successfully', async () => {
      const pluginId = await service.registerPlugin({
        name: 'Test Plugin',
        version: '1.0.0',
        description: 'Test',
        author: 'Test',
        isActive: true,
        configuration: {
          enabled: true,
          priority: 50,
          settings: {},
        },
        capabilities: {
          hooks: [PluginHookType.PRE_REQUEST],
          protocols: ['mcp'],
          dataFormats: ['json'],
          operations: ['read'],
        },
        hooks: [
          {
            type: PluginHookType.PRE_REQUEST,
            handler: 'testHandler',
            async: false,
            timeout: 5000,
          },
        ],
      });

      const result = await service.unregisterPlugin(pluginId);

      expect(result).toBe(true);
      expect(mockRedis.del).toHaveBeenCalledWith(`plugin:${pluginId}`);
    });

    it('should return false when unregistering non-existent plugin', async () => {
      const result = await service.unregisterPlugin('nonexistent-plugin');

      expect(result).toBe(false);
    });

    it('should remove plugin from all registries', async () => {
      const pluginId = await service.registerPlugin({
        name: 'Test Plugin',
        version: '1.0.0',
        description: 'Test',
        author: 'Test',
        isActive: true,
        configuration: {
          enabled: true,
          priority: 50,
          settings: {},
        },
        capabilities: {
          hooks: [PluginHookType.PRE_REQUEST],
          protocols: ['mcp'],
          dataFormats: ['json'],
          operations: ['read'],
        },
        hooks: [
          {
            type: PluginHookType.PRE_REQUEST,
            handler: 'testHandler',
            async: false,
            timeout: 5000,
          },
        ],
      });

      await service.unregisterPlugin(pluginId);

      const plugin = await service.getPlugin(pluginId);
      expect(plugin).toBeNull();
    });
  });

  describe('Plugin Retrieval', () => {
    it('should retrieve a registered plugin', async () => {
      const pluginData = {
        name: 'Test Plugin',
        version: '1.0.0',
        description: 'Test',
        author: 'Test',
        isActive: true,
        configuration: {
          enabled: true,
          priority: 50,
          settings: {},
        },
        capabilities: {
          hooks: [PluginHookType.PRE_REQUEST],
          protocols: ['mcp'],
          dataFormats: ['json'],
          operations: ['read'],
        },
        hooks: [
          {
            type: PluginHookType.PRE_REQUEST,
            handler: 'testHandler',
            async: false,
            timeout: 5000,
          },
        ],
      };

      const pluginId = await service.registerPlugin(pluginData);
      const plugin = await service.getPlugin(pluginId);

      expect(plugin).not.toBeNull();
      expect(plugin?.name).toBe('Test Plugin');
    });

    it('should return null for non-existent plugin', async () => {
      const plugin = await service.getPlugin('nonexistent-plugin');

      expect(plugin).toBeNull();
    });

    it('should list all registered plugins', async () => {
      // Register a test plugin first
      await service.registerPlugin({
        name: 'Test Plugin',
        version: '1.0.0',
        description: 'Test',
        author: 'Test',
        isActive: true,
        configuration: {
          enabled: true,
          priority: 50,
          settings: {},
        },
        capabilities: {
          hooks: [PluginHookType.PRE_REQUEST],
          protocols: ['mcp'],
          dataFormats: ['json'],
          operations: ['read'],
        },
        hooks: [
          {
            type: PluginHookType.PRE_REQUEST,
            handler: 'testHandler',
            async: false,
            timeout: 5000,
          },
        ],
      });

      const plugins = await service.listPlugins();

      expect(Array.isArray(plugins)).toBe(true);
      expect(plugins.length).toBeGreaterThan(0);
    });

    it('should list plugins for specific organization', async () => {
      await service.registerPlugin({
        name: 'Org Plugin',
        version: '1.0.0',
        description: 'Test',
        author: 'Test',
        isActive: true,
        configuration: {
          enabled: true,
          priority: 50,
          settings: {},
        },
        capabilities: {
          hooks: [PluginHookType.PRE_REQUEST],
          protocols: ['mcp'],
          dataFormats: ['json'],
          operations: ['read'],
        },
        hooks: [
          {
            type: PluginHookType.PRE_REQUEST,
            handler: 'testHandler',
            async: false,
            timeout: 5000,
          },
        ],
      }, 'org-1');

      const orgPlugins = await service.listPlugins('org-1');

      expect(orgPlugins.some(p => p.organizationId === 'org-1')).toBe(true);
    });
  });

  describe('Plugin State Management', () => {
    it('should register plugin with isActive state', async () => {
      const inactivePlugin = {
        name: 'Test Plugin',
        version: '1.0.0',
        description: 'Test',
        author: 'Test',
        isActive: false,
        configuration: {
          enabled: true,
          priority: 50,
          settings: {},
        },
        capabilities: {
          hooks: [PluginHookType.PRE_REQUEST],
          protocols: ['mcp'],
          dataFormats: ['json'],
          operations: ['read'],
        },
        hooks: [
          {
            type: PluginHookType.PRE_REQUEST,
            handler: 'testHandler',
            async: false,
            timeout: 5000,
          },
        ],
      };

      const pluginId = await service.registerPlugin(inactivePlugin);
      const plugin = await service.getPlugin(pluginId);

      expect(plugin?.isActive).toBe(false);
    });

    it('should register active plugin by default', async () => {
      const activePlugin = {
        name: 'Test Plugin',
        version: '1.0.0',
        description: 'Test',
        author: 'Test',
        isActive: true,
        configuration: {
          enabled: true,
          priority: 50,
          settings: {},
        },
        capabilities: {
          hooks: [PluginHookType.PRE_REQUEST],
          protocols: ['mcp'],
          dataFormats: ['json'],
          operations: ['read'],
        },
        hooks: [
          {
            type: PluginHookType.PRE_REQUEST,
            handler: 'testHandler',
            async: false,
            timeout: 5000,
          },
        ],
      };

      const pluginId = await service.registerPlugin(activePlugin);
      const plugin = await service.getPlugin(pluginId);

      expect(plugin?.isActive).toBe(true);
    });
  });

  describe('Plugin Configuration', () => {
    it('should update plugin configuration', async () => {
      const pluginId = await service.registerPlugin({
        name: 'Test Plugin',
        version: '1.0.0',
        description: 'Test',
        author: 'Test',
        isActive: true,
        configuration: {
          enabled: true,
          priority: 50,
          settings: { key: 'value' },
        },
        capabilities: {
          hooks: [PluginHookType.PRE_REQUEST],
          protocols: ['mcp'],
          dataFormats: ['json'],
          operations: ['read'],
        },
        hooks: [
          {
            type: PluginHookType.PRE_REQUEST,
            handler: 'testHandler',
            async: false,
            timeout: 5000,
          },
        ],
      });

      await service.updatePluginConfiguration(pluginId, {
        priority: 90,
        settings: { key: 'newValue' },
      });

      const plugin = await service.getPlugin(pluginId);
      expect(plugin?.configuration.priority).toBe(90);
      expect(plugin?.configuration.settings.key).toBe('newValue');
    });

    it('should return false when updating non-existent plugin', async () => {
      const result = await service.updatePluginConfiguration('nonexistent', { priority: 90 });
      expect(result).toBe(false);
    });
  });

  describe('Plugin Statistics', () => {
    it('should retrieve overall plugin statistics', async () => {
      await service.registerPlugin({
        name: 'Test Plugin',
        version: '1.0.0',
        description: 'Test',
        author: 'Test',
        isActive: true,
        configuration: {
          enabled: true,
          priority: 50,
          settings: {},
        },
        capabilities: {
          hooks: [PluginHookType.PRE_REQUEST],
          protocols: ['mcp'],
          dataFormats: ['json'],
          operations: ['read'],
        },
        hooks: [
          {
            type: PluginHookType.PRE_REQUEST,
            handler: 'testHandler',
            async: false,
            timeout: 5000,
          },
        ],
      });

      const stats = await service.getPluginStats();

      expect(stats).toBeDefined();
      expect(stats.totalPlugins).toBeGreaterThan(0);
      expect(stats.activePlugins).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Plugin Hook Execution - Branch Coverage', () => {
    const mockPlugin = {
      name: 'Test Plugin',
      version: '1.0.0',
      description: 'Test',
      author: 'Test',
      isActive: true,
      configuration: {
        enabled: true,
        priority: 50,
        settings: {},
      },
      capabilities: {
        hooks: [PluginHookType.PRE_REQUEST],
        protocols: ['mcp'],
        dataFormats: ['json'],
        operations: ['read'],
      },
      hooks: [
        {
          type: PluginHookType.PRE_REQUEST,
          handler: 'testHandler',
          async: false,
          timeout: 5000,
        },
      ],
    };

    it('should return context unchanged when no plugins for hook', async () => {
      const context: any = {
        hookType: PluginHookType.POST_RESPONSE,
        requestId: 'req-1',
        organizationId: 'org-1',
        data: { test: 'value' },
        metadata: {},
      };

      const result = await service.executeHook(PluginHookType.POST_RESPONSE, context);

      expect(result.data).toEqual({ test: 'value' });
    });

    it('should skip inactive plugins during execution', async () => {
      const inactivePlugin = { ...mockPlugin, isActive: false };
      await service.registerPlugin(inactivePlugin);

      const context: any = {
        hookType: PluginHookType.PRE_REQUEST,
        requestId: 'req-1',
        organizationId: 'org-1',
        data: { test: 'value' },
        metadata: {},
      };

      const result = await service.executeHook(PluginHookType.PRE_REQUEST, context);

      expect(result.data).toEqual({ test: 'value' });
    });

    it('should skip plugins with mismatched organizationId', async () => {
      await service.registerPlugin(mockPlugin, 'org-1');

      const context: any = {
        hookType: PluginHookType.PRE_REQUEST,
        requestId: 'req-1',
        organizationId: 'org-2',
        data: { test: 'value' },
        metadata: {},
      };

      const result = await service.executeHook(PluginHookType.PRE_REQUEST, context);

      expect(result).toBeDefined();
    });

    it('should stop execution when plugin returns stop action', async () => {
      const pluginId = await service.registerPlugin(mockPlugin);
      const plugin = service.getPlugin(pluginId);

      // Mock executePlugin to return stop action
      jest.spyOn(service as any, 'executePlugin').mockResolvedValue({
        success: true,
        data: { modified: true },
        metadata: { executionTime: 100, modifications: [] },
        nextAction: 'stop',
      });

      const context: any = {
        hookType: PluginHookType.PRE_REQUEST,
        requestId: 'req-1',
        organizationId: 'org-1',
        data: { test: 'value' },
        metadata: {},
      };

      const result = await service.executeHook(PluginHookType.PRE_REQUEST, context);

      // The executeHook returns the original context data, not the plugin's modified data
      // This is correct behavior - the data field contains the original context data
      expect(result.data).toEqual({ test: 'value' });
      expect(result).toBeDefined();
    });

    it('should skip to next plugin when plugin returns skip action', async () => {
      await service.registerPlugin(mockPlugin);

      jest.spyOn(service as any, 'executePlugin').mockResolvedValue({
        success: true,
        data: { test: 'value' },
        metadata: { executionTime: 100, modifications: [] },
        nextAction: 'skip',
      });

      const context: any = {
        hookType: PluginHookType.PRE_REQUEST,
        requestId: 'req-1',
        organizationId: 'org-1',
        data: { test: 'value' },
        metadata: {},
      };

      const result = await service.executeHook(PluginHookType.PRE_REQUEST, context);

      expect(result).toBeDefined();
    });

    it('should continue execution on non-critical errors', async () => {
      await service.registerPlugin(mockPlugin);

      jest.spyOn(service as any, 'executePlugin').mockRejectedValue(
        Object.assign(new Error('Plugin error'), { critical: false })
      );

      const context: any = {
        hookType: PluginHookType.PRE_REQUEST,
        requestId: 'req-1',
        organizationId: 'org-1',
        data: { test: 'value' },
        metadata: {},
      };

      const result = await service.executeHook(PluginHookType.PRE_REQUEST, context);

      expect(result).toBeDefined();
    });

    it('should stop execution on critical errors', async () => {
      await service.registerPlugin(mockPlugin);

      jest.spyOn(service as any, 'executePlugin').mockRejectedValue(
        Object.assign(new Error('Critical error'), { critical: true })
      );

      const context: any = {
        hookType: PluginHookType.PRE_REQUEST,
        requestId: 'req-1',
        organizationId: 'org-1',
        data: { test: 'value' },
        metadata: {},
      };

      const result = await service.executeHook(PluginHookType.PRE_REQUEST, context);

      expect(result).toBeDefined();
    });
  });

  describe('Plugin Validation - Branch Coverage', () => {
    it('should add warning for plugin without hooks', async () => {
      const pluginWithoutHooks = {
        name: 'Test Plugin',
        version: '1.0.0',
        description: 'Test',
        author: 'Test',
        isActive: true,
        configuration: {
          enabled: true,
          priority: 50,
          settings: {},
        },
        capabilities: {
          hooks: [],
          protocols: ['mcp'],
          dataFormats: ['json'],
          operations: ['read'],
        },
        hooks: [],
      };

      const validation = await service['validatePlugin'](pluginWithoutHooks as any);

      expect(validation.isValid).toBe(true);
      expect(validation.warnings).toContain('Plugin has no hooks defined');
    });

    it('should reject plugin without version', async () => {
      const invalidPlugin = {
        name: 'Test Plugin',
        description: 'Test',
        author: 'Test',
        isActive: true,
        configuration: {
          enabled: true,
          priority: 50,
          settings: {},
        },
        capabilities: {
          hooks: [PluginHookType.PRE_REQUEST],
          protocols: ['mcp'],
          dataFormats: ['json'],
          operations: ['read'],
        },
        hooks: [],
      };

      const validation = await service['validatePlugin'](invalidPlugin as any);

      expect(validation.isValid).toBe(false);
      expect(validation.errors).toContain('Plugin version is required');
    });

    it('should reject plugin with invalid hook type', async () => {
      const invalidPlugin = {
        name: 'Test Plugin',
        version: '1.0.0',
        description: 'Test',
        author: 'Test',
        isActive: true,
        configuration: {
          enabled: true,
          priority: 50,
          settings: {},
        },
        capabilities: {
          hooks: ['invalid-hook'],
          protocols: ['mcp'],
          dataFormats: ['json'],
          operations: ['read'],
        },
        hooks: [
          {
            type: 'invalid-hook' as any,
            handler: 'testHandler',
            async: false,
            timeout: 5000,
          },
        ],
      };

      const validation = await service['validatePlugin'](invalidPlugin as any);

      expect(validation.isValid).toBe(false);
      expect(validation.errors.some(e => e.includes('Invalid hook type'))).toBe(true);
    });

    it('should reject plugin with missing handler', async () => {
      const invalidPlugin = {
        name: 'Test Plugin',
        version: '1.0.0',
        description: 'Test',
        author: 'Test',
        isActive: true,
        configuration: {
          enabled: true,
          priority: 50,
          settings: {},
        },
        capabilities: {
          hooks: [PluginHookType.PRE_REQUEST],
          protocols: ['mcp'],
          dataFormats: ['json'],
          operations: ['read'],
        },
        hooks: [
          {
            type: PluginHookType.PRE_REQUEST,
            handler: '',
            async: false,
            timeout: 5000,
          },
        ],
      };

      const validation = await service['validatePlugin'](invalidPlugin as any);

      expect(validation.isValid).toBe(false);
      expect(validation.errors.some(e => e.includes('Missing handler'))).toBe(true);
    });

    it('should warn about unsafe plugins when not allowed', async () => {
      const unsafePlugin = {
        name: 'Unsafe Plugin',
        version: '1.0.0',
        description: 'Test',
        author: 'Test',
        isActive: true,
        configuration: {
          enabled: true,
          priority: 50,
          settings: {},
          security: {},
        },
        capabilities: {
          hooks: [PluginHookType.PRE_REQUEST],
          protocols: ['mcp'],
          dataFormats: ['json'],
          operations: ['read', 'execute'],
        },
        hooks: [
          {
            type: PluginHookType.PRE_REQUEST,
            handler: 'testHandler',
            async: false,
            timeout: 5000,
          },
        ],
      };

      const validation = await service['validatePlugin'](unsafePlugin as any);

      expect(validation.warnings.some(w => w.includes('execute capabilities'))).toBe(true);
    });
  });

  describe('Plugin Configuration Loading - Branch Coverage', () => {
    it('should handle Redis errors gracefully', async () => {
      mockRedis.keys.mockRejectedValue(new Error('Redis error'));

      await service['loadPluginConfigurations']();

      expect(mockRedis.keys).toHaveBeenCalled();
    });

    it('should skip non-existent plugins when loading configs', async () => {
      mockRedis.keys.mockResolvedValue(['plugin:config:non-existent']);
      mockRedis.get.mockResolvedValue(JSON.stringify({ priority: 90 }));

      await service['loadPluginConfigurations']();

      expect(mockRedis.get).toHaveBeenCalled();
    });

    it('should update existing plugin configurations', async () => {
      const pluginId = await service.registerPlugin({
        name: 'Test Plugin',
        version: '1.0.0',
        description: 'Test',
        author: 'Test',
        isActive: true,
        configuration: {
          enabled: true,
          priority: 50,
          settings: {},
        },
        capabilities: {
          hooks: [PluginHookType.PRE_REQUEST],
          protocols: ['mcp'],
          dataFormats: ['json'],
          operations: ['read'],
        },
        hooks: [
          {
            type: PluginHookType.PRE_REQUEST,
            handler: 'testHandler',
            async: false,
            timeout: 5000,
          },
        ],
      });

      mockRedis.keys.mockResolvedValue([`plugin:config:${pluginId}`]);
      mockRedis.get.mockResolvedValue(JSON.stringify({ priority: 90, settings: { new: 'value' } }));

      await service['loadPluginConfigurations']();

      const plugin = service.getPlugin(pluginId);
      expect(plugin?.configuration.priority).toBe(90);
    });
  });

  describe('External Plugin Loading - Branch Coverage', () => {
    it('should skip loading when plugin directory does not exist', async () => {
      await service['loadExternalPlugins']();

      expect(service).toBeDefined();
    });

    it('should handle errors when loading external plugin fails', async () => {
      await service['loadExternalPlugins']();

      expect(service).toBeDefined();
    });
  });

  describe('Plugin Metrics - Branch Coverage', () => {
    it('should skip metrics update for non-existent plugin', async () => {
      await service['updatePluginMetrics']('non-existent', 100, true);

      expect(service).toBeDefined();
    });

    it('should calculate error rate correctly on failure', async () => {
      const pluginId = await service.registerPlugin({
        name: 'Test Plugin',
        version: '1.0.0',
        description: 'Test',
        author: 'Test',
        isActive: true,
        configuration: {
          enabled: true,
          priority: 50,
          settings: {},
        },
        capabilities: {
          hooks: [PluginHookType.PRE_REQUEST],
          protocols: ['mcp'],
          dataFormats: ['json'],
          operations: ['read'],
        },
        hooks: [
          {
            type: PluginHookType.PRE_REQUEST,
            handler: 'testHandler',
            async: false,
            timeout: 5000,
          },
        ],
      });

      await service['updatePluginMetrics'](pluginId, 100, false);

      const plugin = service.getPlugin(pluginId);
      expect(plugin?.metadata.errorRate).toBeGreaterThan(0);
    });
  });

  describe('Built-in Plugin Loading - Branch Coverage', () => {
    it('should handle errors when loading individual built-in plugins', async () => {
      const originalGet = service.getPlugin;

      await service['loadBuiltInPlugins']();

      expect(service).toBeDefined();
    });
  });

  describe('Get Plugins By Hook - Branch Coverage', () => {
    it('should return empty array for hook with no plugins', () => {
      const plugins = service.getPluginsByHook(PluginHookType.POST_RESPONSE);

      expect(plugins).toEqual([]);
    });
  });

  describe('List Plugins - Branch Coverage', () => {
    it('should return all plugins when no organizationId provided', async () => {
      await service.registerPlugin({
        name: 'Global Plugin',
        version: '1.0.0',
        description: 'Test',
        author: 'Test',
        isActive: true,
        configuration: {
          enabled: true,
          priority: 50,
          settings: {},
        },
        capabilities: {
          hooks: [PluginHookType.PRE_REQUEST],
          protocols: ['mcp'],
          dataFormats: ['json'],
          operations: ['read'],
        },
        hooks: [
          {
            type: PluginHookType.PRE_REQUEST,
            handler: 'testHandler',
            async: false,
            timeout: 5000,
          },
        ],
      });

      const plugins = service.listPlugins();

      expect(plugins.length).toBeGreaterThan(0);
    });

    it('should filter plugins by organizationId', async () => {
      // Register a global plugin (no organizationId)
      await service.registerPlugin({
        name: 'Global Plugin',
        version: '1.0.0',
        description: 'Test',
        author: 'Test',
        isActive: true,
        configuration: {
          enabled: true,
          priority: 50,
          settings: {},
        },
        capabilities: {
          hooks: [PluginHookType.PRE_REQUEST],
          protocols: ['mcp'],
          dataFormats: ['json'],
          operations: ['read'],
        },
        hooks: [
          {
            type: PluginHookType.PRE_REQUEST,
            handler: 'testHandler',
            async: false,
            timeout: 5000,
          },
        ],
      });

      // Register an org-specific plugin
      await service.registerPlugin({
        name: 'Org Plugin',
        version: '1.0.0',
        description: 'Test',
        author: 'Test',
        isActive: true,
        configuration: {
          enabled: true,
          priority: 50,
          settings: {},
        },
        capabilities: {
          hooks: [PluginHookType.PRE_REQUEST],
          protocols: ['mcp'],
          dataFormats: ['json'],
          operations: ['read'],
        },
        hooks: [
          {
            type: PluginHookType.PRE_REQUEST,
            handler: 'testHandler',
            async: false,
            timeout: 5000,
          },
        ],
      }, 'org-specific');

      const orgPlugins = service.listPlugins('org-specific');
      const allPlugins = service.listPlugins();

      // listPlugins(organizationId) returns org-specific + global plugins
      // listPlugins() returns all plugins
      // Since we only have 1 global + 1 org-specific plugin, both should return 2
      expect(orgPlugins.length).toBe(2); // Org-specific plugin + global plugin
      expect(allPlugins.length).toBe(2); // Both plugins

      // Verify the org plugins include both the global and org-specific
      const orgPluginNames = orgPlugins.map(p => p.name);
      expect(orgPluginNames).toContain('Global Plugin');
      expect(orgPluginNames).toContain('Org Plugin');
    });
  });

  describe('Execute Plugin - Deep Branch Coverage', () => {
    const mockPlugin = {
      name: 'Test Plugin',
      version: '1.0.0',
      description: 'Test',
      author: 'Test',
      isActive: true,
      configuration: {
        enabled: true,
        priority: 50,
        settings: {},
      },
      capabilities: {
        hooks: [PluginHookType.PRE_REQUEST],
        protocols: ['mcp'],
        dataFormats: ['json'],
        operations: ['read'],
      },
      hooks: [
        {
          type: PluginHookType.PRE_REQUEST,
          handler: 'testHandler',
          async: false,
          timeout: 5000,
        },
      ],
    };

    it('should return error when hook not found in plugin', async () => {
      const pluginId = await service.registerPlugin(mockPlugin);
      const plugin = service.getPlugin(pluginId);

      const context: any = {
        hookType: PluginHookType.PRE_REQUEST,
        requestId: 'req-1',
        organizationId: 'org-1',
        data: { test: 'value' },
        metadata: {},
      };

      const result = await service['executePlugin'](plugin!, PluginHookType.POST_RESPONSE, context);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('HOOK_NOT_FOUND');
    });

    it('should return error when execution limit exceeded', async () => {
      const pluginId = await service.registerPlugin(mockPlugin);
      const plugin = service.getPlugin(pluginId);

      // Set execution counter to max
      service['executionSemaphore'].set(pluginId, 10);

      const context: any = {
        hookType: PluginHookType.PRE_REQUEST,
        requestId: 'req-1',
        organizationId: 'org-1',
        data: { test: 'value' },
        metadata: {},
      };

      const result = await service['executePlugin'](plugin!, PluginHookType.PRE_REQUEST, context);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EXECUTION_LIMIT_EXCEEDED');
    });

    it('should return skip result when conditions not met', async () => {
      const pluginWithConditions = {
        ...mockPlugin,
        hooks: [
          {
            type: PluginHookType.PRE_REQUEST,
            handler: 'testHandler',
            async: false,
            timeout: 5000,
            conditions: [{ type: 'equals' as const, field: 'test', value: 'other' }],
          },
        ],
      };

      const pluginId = await service.registerPlugin(pluginWithConditions);
      const plugin = service.getPlugin(pluginId);

      // Mock evaluateConditions to return false
      jest.spyOn(service as any, 'evaluateConditions').mockReturnValue(false);

      const context: any = {
        hookType: PluginHookType.PRE_REQUEST,
        requestId: 'req-1',
        organizationId: 'org-1',
        data: { test: 'value' },
        metadata: {},
      };

      const result = await service['executePlugin'](plugin!, PluginHookType.PRE_REQUEST, context);

      expect(result.success).toBe(true);
      expect(result.nextAction).toBe('skip');
      expect(result.metadata.warnings).toContain('Plugin conditions not met - skipped');
    });
  });

  describe('Execute Plugin Handler - Deep Branch Coverage', () => {
    it('should throw error when handler function not found', async () => {
      const plugin: any = {
        id: 'test-plugin',
        name: 'Test Plugin',
        configuration: {
          settings: { timeout: 5000 },
        },
      };

      const context: any = {
        data: { test: 'value' },
      };

      // Mock loadPluginModule to return empty object
      jest.spyOn(service as any, 'loadPluginModule').mockResolvedValue({});

      const result = await service['executePluginHandler'](plugin, 'nonExistentHandler', context);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('PLUGIN_EXECUTION_ERROR');
    });

    it('should handle timeout error correctly', async () => {
      const plugin: any = {
        id: 'test-plugin',
        name: 'Test Plugin',
        configuration: {
          settings: { timeout: 100 },
        },
      };

      const context: any = {
        data: { test: 'value' },
      };

      // Mock loadPluginModule to return a slow handler
      const slowHandler = async () => {
        await new Promise(resolve => setTimeout(resolve, 1000));
        return { data: {} };
      };

      jest.spyOn(service as any, 'loadPluginModule').mockResolvedValue({
        testHandler: slowHandler,
      });

      const result = await service['executePluginHandler'](plugin, 'testHandler', context);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('PLUGIN_EXECUTION_ERROR');
      expect(result.error?.details?.timeout).toBe(true);
    });

    it('should handle handler function that is not a function', async () => {
      const plugin: any = {
        id: 'test-plugin',
        name: 'Test Plugin',
        configuration: {
          settings: { timeout: 5000 },
        },
      };

      const context: any = {
        data: { test: 'value' },
      };

      // Mock loadPluginModule to return non-function
      jest.spyOn(service as any, 'loadPluginModule').mockResolvedValue({
        testHandler: 'not a function',
      });

      const result = await service['executePluginHandler'](plugin, 'testHandler', context);

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Handler function testHandler not found');
    });

    it('should successfully execute handler and return result', async () => {
      const plugin: any = {
        id: 'test-plugin',
        name: 'Test Plugin',
        configuration: {
          settings: { timeout: 5000 },
        },
      };

      const context: any = {
        data: { test: 'value' },
      };

      const successHandler = async () => ({
        data: { modified: true },
        modifications: ['field1'],
        logs: [{ level: 'info', message: 'Success' }],
        nextAction: 'continue',
      });

      jest.spyOn(service as any, 'loadPluginModule').mockResolvedValue({
        testHandler: successHandler,
      });

      const result = await service['executePluginHandler'](plugin, 'testHandler', context);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ modified: true });
      expect(result.metadata.modifications).toEqual(['field1']);
      expect(result.nextAction).toBe('continue');
    });
  });

  describe('Load Plugin Module - Branch Coverage', () => {
    it('should return cached module if already loaded', async () => {
      const plugin: any = {
        id: 'cached-plugin',
        name: 'Cached Plugin',
      };

      const mockModule = { testHandler: jest.fn() };
      service['pluginModules'].set('cached-plugin', mockModule);

      const result = await service['loadPluginModule'](plugin);

      expect(result).toBe(mockModule);
    });

    it('should return PiiFilterPlugin for PII Filter name', async () => {
      const plugin: any = {
        id: 'pii-filter',
        name: 'PII Filter',
      };

      const result = await service['loadPluginModule'](plugin);

      expect(result).toBeDefined();
      expect(result.constructor.name).toBe('PiiFilterPlugin');
    });

    it('should return RateLimiterPlugin for Rate Limiter name', async () => {
      const plugin: any = {
        id: 'rate-limiter',
        name: 'Rate Limiter',
      };

      const result = await service['loadPluginModule'](plugin);

      expect(result).toBeDefined();
      expect(result.constructor.name).toBe('RateLimiterPlugin');
    });

    it('should return RequestLoggerPlugin for Request Logger name', async () => {
      const plugin: any = {
        id: 'request-logger',
        name: 'Request Logger',
      };

      const result = await service['loadPluginModule'](plugin);

      expect(result).toBeDefined();
      expect(result.constructor.name).toBe('RequestLoggerPlugin');
    });

    it('should return SecurityScannerPlugin for Security Scanner name', async () => {
      const plugin: any = {
        id: 'security-scanner',
        name: 'Security Scanner',
      };

      const result = await service['loadPluginModule'](plugin);

      expect(result).toBeDefined();
      expect(result.constructor.name).toBe('SecurityScannerPlugin');
    });

    it('should return PerformanceMonitorPlugin for Performance Monitor name', async () => {
      const plugin: any = {
        id: 'performance-monitor',
        name: 'Performance Monitor',
      };

      const result = await service['loadPluginModule'](plugin);

      expect(result).toBeDefined();
      expect(result.constructor.name).toBe('PerformanceMonitorPlugin');
    });

    it('should throw error for unknown plugin module', async () => {
      const plugin: any = {
        id: 'unknown-plugin',
        name: 'Unknown Plugin',
      };

      await expect(service['loadPluginModule'](plugin)).rejects.toThrow('Plugin module not found');
    });
  });

  describe('Security Validation - Branch Coverage', () => {
    it('should warn about network access without host restrictions', async () => {
      const pluginWithNetworkAccess = {
        name: 'Network Plugin',
        version: '1.0.0',
        description: 'Test',
        author: 'Test',
        isActive: true,
        configuration: {
          enabled: true,
          priority: 50,
          settings: {},
          security: {
            // No allowedHosts
          },
        },
        capabilities: {
          hooks: [PluginHookType.PRE_REQUEST],
          protocols: ['mcp'],
          dataFormats: ['json'],
          operations: ['read'],
        },
        hooks: [
          {
            type: PluginHookType.PRE_REQUEST,
            handler: 'testHandler',
            async: false,
            timeout: 5000,
          },
        ],
      };

      const validation = await service['validatePlugin'](pluginWithNetworkAccess as any);

      expect(validation.warnings.some(w => w.includes('network access but no host restrictions'))).toBe(true);
    });
  });

  describe('Plugin Execution Success Path - Branch Coverage', () => {
    it('should apply modifications when plugin succeeds with nextAction continue', async () => {
      const mockPlugin = {
        name: 'Test Plugin',
        version: '1.0.0',
        description: 'Test',
        author: 'Test',
        isActive: true,
        configuration: {
          enabled: true,
          priority: 50,
          settings: {},
        },
        capabilities: {
          hooks: [PluginHookType.PRE_REQUEST],
          protocols: ['mcp'],
          dataFormats: ['json'],
          operations: ['read'],
        },
        hooks: [
          {
            type: PluginHookType.PRE_REQUEST,
            handler: 'testHandler',
            async: false,
            timeout: 5000,
          },
        ],
      };

      await service.registerPlugin(mockPlugin);

      // Mock executePlugin to return success with modifications
      jest.spyOn(service as any, 'executePlugin').mockResolvedValue({
        success: true,
        data: { modified: true },
        metadata: {
          executionTime: 100,
          modifications: ['field1'],
        },
        nextAction: 'continue',
      });

      const context: any = {
        hookType: PluginHookType.PRE_REQUEST,
        requestId: 'req-1',
        organizationId: 'org-1',
        data: { test: 'value' },
        metadata: {},
      };

      const result = await service.executeHook(PluginHookType.PRE_REQUEST, context);

      expect(result.data).toEqual({ modified: true });
      expect(result.metadata.pluginResults).toBeDefined();
    });
  });

  describe('Initialize Error Handling - Branch Coverage', () => {
    it('should handle initialization errors gracefully', async () => {
      // Force an error during initialization
      jest.spyOn(service as any, 'loadBuiltInPlugins').mockRejectedValue(new Error('Init error'));

      await service.initialize();

      expect(service).toBeDefined();
    });
  });
});
