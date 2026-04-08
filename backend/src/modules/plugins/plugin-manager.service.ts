import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter } from 'events';
import { InjectRedis } from '@nestjs-modules/ioredis';
import * as Redis from 'ioredis';
import * as path from 'path';
import * as fs from 'fs/promises';

import {
  Plugin,
  PluginHookType,
  PluginContext,
  PluginResult,
  PluginRegistry,
  PluginManagerConfig,
  PluginInstallation,
  BuiltInPluginType,
  PluginEvent,
} from './types/plugin.types';

import { PiiFilterPlugin } from './built-in/pii-filter.plugin';
import { RateLimiterPlugin } from './built-in/rate-limiter.plugin';
import { RequestLoggerPlugin } from './built-in/request-logger.plugin';
import { SecurityScannerPlugin } from './built-in/security-scanner.plugin';
import { PerformanceMonitorPlugin } from './built-in/performance-monitor.plugin';

@Injectable()
export class PluginManagerService extends EventEmitter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PluginManagerService.name);
  private readonly registry: PluginRegistry = {
    plugins: new Map(),
    byHook: new Map(),
    byOrganization: new Map(),
    globalPlugins: [],
  };
  
  private readonly installations = new Map<string, PluginInstallation>();
  private readonly executionSemaphore = new Map<string, number>(); // Concurrent execution tracking
  
  private readonly config: PluginManagerConfig = {
    maxConcurrentExecutions: 10,
    defaultTimeout: 30000,
    enableSandbox: true,
    allowUnsafePlugins: false,
    pluginDirectory: path.join(process.cwd(), 'plugins'),
  };

  constructor(
    @InjectRedis() private readonly redis: Redis.Redis,
  ) {
    super();
    this.setupEventHandlers();
  }

  async onModuleInit() {
    await this.initialize();
  }

  async onModuleDestroy() {
    await this.shutdown();
  }

  // Plugin Manager Initialization
  async initialize(): Promise<void> {
    this.logger.log('Initializing Plugin Manager');

    try {
      // Load built-in plugins
      await this.loadBuiltInPlugins();
      
      // Load external plugins from directory
      await this.loadExternalPlugins();
      
      // Load plugin configurations from Redis
      await this.loadPluginConfigurations();
      
      this.logger.log(`Plugin Manager initialized with ${this.registry.plugins.size} plugins`);
      
    } catch (error) {
      this.logger.error(`Failed to initialize Plugin Manager: ${error.message}`);
    }
  }

  // Execute Plugin Hooks
  async executeHook(
    hookType: PluginHookType,
    context: PluginContext,
  ): Promise<PluginContext> {
    const pluginIds = this.registry.byHook.get(hookType) || [];
    
    if (pluginIds.length === 0) {
      return context; // No plugins for this hook
    }

    this.logger.debug(`Executing ${pluginIds.length} plugins for hook: ${hookType}`);

    let currentContext = { ...context };
    const results: Array<{ pluginId: string; result: PluginResult }> = [];

    // Execute plugins in priority order
    const sortedPlugins = pluginIds
      .map(id => this.registry.plugins.get(id))
      .filter(Boolean)
      .sort((a, b) => (b!.configuration.priority || 50) - (a!.configuration.priority || 50));

    for (const plugin of sortedPlugins) {
      if (!plugin || !plugin.isActive) {
        continue;
      }

      // Check organization context
      if (plugin.organizationId && plugin.organizationId !== context.organizationId) {
        continue;
      }

      try {
        const pluginResult = await this.executePlugin(plugin, hookType, currentContext);
        results.push({ pluginId: plugin.id, result: pluginResult });

        if (pluginResult.success && pluginResult.nextAction !== 'stop') {
          // Apply plugin modifications
          currentContext.data = pluginResult.data;
          
          // Merge metadata
          currentContext.metadata = {
            ...currentContext.metadata,
            pluginResults: [
              ...(currentContext.metadata.pluginResults || []),
              {
                pluginId: plugin.id,
                executionTime: pluginResult.metadata.executionTime,
                modifications: pluginResult.metadata.modifications,
              },
            ],
          };
        }

        if (pluginResult.nextAction === 'stop') {
          this.logger.debug(`Plugin ${plugin.id} requested stop - halting hook chain`);
          break;
        }

        if (pluginResult.nextAction === 'skip') {
          continue;
        }

      } catch (error) {
        this.logger.error(`Plugin execution failed: ${plugin.id} - ${error.message}`);
        
        // Emit plugin error event
        await this.emitPluginEvent(plugin.id, 'error', error.message, context.organizationId);
        
        // Continue with other plugins unless it's a critical error
        if (error.critical) {
          break;
        }
      }
    }

    return currentContext;
  }

  // Execute Individual Plugin
  private async executePlugin(
    plugin: Plugin,
    hookType: PluginHookType,
    context: PluginContext,
  ): Promise<PluginResult> {
    const startTime = Date.now();
    const pluginHook = plugin.hooks.find(h => h.type === hookType);
    
    if (!pluginHook) {
      return {
        success: false,
        data: context.data,
        error: {
          code: 'HOOK_NOT_FOUND',
          message: `Plugin ${plugin.id} does not support hook ${hookType}`,
        },
        metadata: {
          executionTime: Date.now() - startTime,
          modifications: [],
        },
      };
    }

    // Check execution limits
    const currentExecutions = this.executionSemaphore.get(plugin.id) || 0;
    if (currentExecutions >= this.config.maxConcurrentExecutions) {
      return {
        success: false,
        data: context.data,
        error: {
          code: 'EXECUTION_LIMIT_EXCEEDED',
          message: 'Plugin execution limit exceeded',
        },
        metadata: {
          executionTime: Date.now() - startTime,
          modifications: [],
        },
      };
    }

    // Increment execution counter
    this.executionSemaphore.set(plugin.id, currentExecutions + 1);

    try {
      // Check plugin conditions
      if (pluginHook.conditions && !this.evaluateConditions(pluginHook.conditions, context)) {
        return {
          success: true,
          data: context.data,
          metadata: {
            executionTime: Date.now() - startTime,
            modifications: [],
            warnings: ['Plugin conditions not met - skipped'],
          },
          nextAction: 'skip',
        };
      }

      // Execute plugin based on type
      const result = await this.executePluginHandler(plugin, pluginHook.handler, context);

      // Update plugin usage metrics
      await this.updatePluginMetrics(plugin.id, Date.now() - startTime, result.success);

      return result;

    } finally {
      // Decrement from the CURRENT value, not from the captured
      // pre-increment one. The previous shape wrote back
      // `currentExecutions - 1`, which under concurrent execution let the
      // counter drift arbitrarily: N overlapping runs captured the same
      // pre-value, each set "+1" on entry, and on exit each set "-1" from
      // that same captured value, so the counter ended up N below its
      // true state (clamped to 0). Net effect: the
      // maxConcurrentExecutions ceiling became unenforceable whenever
      // the plugin was actually under load.
      const running = this.executionSemaphore.get(plugin.id) || 0;
      this.executionSemaphore.set(plugin.id, Math.max(0, running - 1));
    }
  }

  private async executePluginHandler(
    plugin: Plugin,
    handlerName: string,
    context: PluginContext,
  ): Promise<PluginResult> {
    const startTime = Date.now();

    try {
      // Reject handler names that could resolve to prototype builtins
      // (`__proto__`, `toString`, …) or that contain non-identifier
      // characters. Without this, an external plugin manifest could
      // nominate `toString` as its handler and we'd happily call the
      // Object builtin with `(context, settings)`. Built-in plugin
      // methods (filterPiiFromRequest etc.) live on the prototype, so
      // we still do a normal `pluginModule[name]` lookup after the
      // safelist check — the safelist is what blocks the escape, not
      // own-property enforcement.
      if (!this.isSafeHandlerName(handlerName)) {
        throw new Error(`Unsafe or invalid handler name: ${handlerName}`);
      }

      // Load plugin module
      const pluginModule = await this.loadPluginModule(plugin);

      // Get handler function
      const handlerFunction = pluginModule[handlerName];
      if (!handlerFunction || typeof handlerFunction !== 'function') {
        throw new Error(`Handler function ${handlerName} not found in plugin ${plugin.id}`);
      }

      // Execute with timeout. Wrap the race in a pair that clears the
      // timer on either resolution — without that, a handler finishing
      // before the timeout still held a setTimeout reference alive for
      // up to `defaultTimeout` (30s) ms afterwards. At high throughput
      // that was a steady leak of unref'd timer handles.
      const timeoutMs = plugin.configuration.settings.timeout || this.config.defaultTimeout;
      const result: any = await this.runWithTimeout<any>(
        handlerFunction(context, plugin.configuration.settings),
        timeoutMs,
      );

      return {
        success: true,
        data: result.data || context.data,
        metadata: {
          executionTime: Date.now() - startTime,
          modifications: result.modifications || [],
          logs: result.logs || [],
        },
        nextAction: result.nextAction || 'continue',
      };

    } catch (error) {
      return {
        success: false,
        data: context.data,
        error: {
          code: 'PLUGIN_EXECUTION_ERROR',
          message: error.message,
          details: {
            plugin: plugin.id,
            handler: handlerName,
            timeout: error.name === 'TimeoutError',
          },
        },
        metadata: {
          executionTime: Date.now() - startTime,
          modifications: [],
          logs: [
            {
              level: 'error',
              message: error.message,
              timestamp: new Date().toISOString(),
            },
          ],
        },
      };
    }
  }

  // Plugin Registration and Management
  async registerPlugin(
    pluginData: Omit<Plugin, 'id' | 'metadata'>,
    organizationId?: string,
  ): Promise<string> {
    const pluginId = `plugin_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const plugin: Plugin = {
      ...pluginData,
      id: pluginId,
      organizationId,
      metadata: {
        installationDate: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        usageCount: 0,
        averageExecutionTime: 0,
        errorRate: 0,
      },
    };

    // Validate plugin
    const validation = await this.validatePlugin(plugin);
    if (!validation.isValid) {
      throw new Error(`Plugin validation failed: ${validation.errors.join(', ')}`);
    }

    // Register plugin
    this.registry.plugins.set(pluginId, plugin);

    // Update hook registry. Guard against duplicate registration — without
    // the includes() check, calling registerPlugin twice for the same id
    // (e.g. a hot reload, or a test that re-runs initialisation) would
    // push the same pluginId onto the per-hook array multiple times, and
    // executeHook would then run that plugin N times in a single chain.
    for (const hook of plugin.hooks) {
      if (!this.registry.byHook.has(hook.type)) {
        this.registry.byHook.set(hook.type, []);
      }
      const hookList = this.registry.byHook.get(hook.type)!;
      if (!hookList.includes(pluginId)) {
        hookList.push(pluginId);
      }
    }

    // Update organization registry (same dedup rationale).
    if (organizationId) {
      if (!this.registry.byOrganization.has(organizationId)) {
        this.registry.byOrganization.set(organizationId, []);
      }
      const orgList = this.registry.byOrganization.get(organizationId)!;
      if (!orgList.includes(pluginId)) {
        orgList.push(pluginId);
      }
    } else if (!this.registry.globalPlugins.includes(pluginId)) {
      this.registry.globalPlugins.push(pluginId);
    }

    // Store in Redis
    await this.redis.setex(`plugin:${pluginId}`, 86400, JSON.stringify(plugin));

    // Emit plugin event
    await this.emitPluginEvent(pluginId, 'installed', 'Plugin registered successfully', organizationId);

    this.logger.log(`Plugin registered: ${pluginId} (${plugin.name})`);
    
    return pluginId;
  }

  async unregisterPlugin(pluginId: string): Promise<boolean> {
    const plugin = this.registry.plugins.get(pluginId);
    if (!plugin) {
      return false;
    }

    // Remove from all registries
    this.registry.plugins.delete(pluginId);
    
    // Remove from hook registry
    for (const [hookType, pluginIds] of this.registry.byHook.entries()) {
      const index = pluginIds.indexOf(pluginId);
      if (index > -1) {
        pluginIds.splice(index, 1);
      }
    }

    // Remove from organization registry
    if (plugin.organizationId) {
      const orgPlugins = this.registry.byOrganization.get(plugin.organizationId);
      if (orgPlugins) {
        const index = orgPlugins.indexOf(pluginId);
        if (index > -1) {
          orgPlugins.splice(index, 1);
        }
      }
    } else {
      const index = this.registry.globalPlugins.indexOf(pluginId);
      if (index > -1) {
        this.registry.globalPlugins.splice(index, 1);
      }
    }

    // Remove from Redis
    await this.redis.del(`plugin:${pluginId}`);

    // Drop the cached module reference AND the per-plugin
    // concurrency counter. Pre-fix, unregisterPlugin cleared the
    // registry maps but left both pluginModules and executionSemaphore
    // entries in memory forever — a slow leak, and worse, a stale
    // executionSemaphore entry would be inherited by a newly
    // registered plugin that happened to reuse the same id (which
    // was guessable until we swapped to crypto.randomBytes, and can
    // still collide during tests).
    this.pluginModules.delete(pluginId);
    this.executionSemaphore.delete(pluginId);

    // Emit plugin event
    await this.emitPluginEvent(pluginId, 'uninstalled', 'Plugin unregistered', plugin.organizationId);

    this.logger.log(`Plugin unregistered: ${pluginId}`);
    return true;
  }

  // Built-in Plugin Loading
  private async loadBuiltInPlugins(): Promise<void> {
    const builtInPlugins = [
      new PiiFilterPlugin(),
      new RateLimiterPlugin(),
      new RequestLoggerPlugin(),
      new SecurityScannerPlugin(),
      new PerformanceMonitorPlugin(),
    ];

    for (const pluginInstance of builtInPlugins) {
      try {
        const plugin = pluginInstance.getPluginDefinition();
        await this.registerPlugin(plugin);
        this.logger.log(`Built-in plugin loaded: ${plugin.name}`);
      } catch (error) {
        this.logger.error(`Failed to load built-in plugin: ${error.message}`);
      }
    }
  }

  // External Plugin Loading
  private async loadExternalPlugins(): Promise<void> {
    try {
      const pluginDir = this.config.pluginDirectory!;
      const exists = await fs.access(pluginDir).then(() => true).catch(() => false);
      
      if (!exists) {
        this.logger.log('Plugin directory not found - skipping external plugin loading');
        return;
      }

      const entries = await fs.readdir(pluginDir, { withFileTypes: true });
      const pluginDirs = entries.filter(entry => entry.isDirectory());

      for (const dir of pluginDirs) {
        try {
          await this.loadExternalPlugin(path.join(pluginDir, dir.name));
        } catch (error) {
          this.logger.error(`Failed to load external plugin ${dir.name}: ${error.message}`);
        }
      }

    } catch (error) {
      this.logger.error(`Failed to load external plugins: ${error.message}`);
    }
  }

  private async loadExternalPlugin(pluginPath: string): Promise<void> {
    // Resolve the plugin root up front so we can assert that every path
    // we derive from the manifest stays inside it.
    const resolvedPluginRoot = path.resolve(pluginPath);

    // Load plugin manifest
    const manifestPath = path.join(resolvedPluginRoot, 'plugin.json');
    const manifestContent = await fs.readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(manifestContent);

    // Resolve + confine manifest.main. Previously this was a raw
    // `path.join(pluginPath, manifest.main || 'index.js')` and `main`
    // is user-controlled — a manifest with
    // `"main": "../../node_modules/whatever/index.js"` would happily
    // `import()` code from outside the plugin directory.
    const requestedMain = typeof manifest.main === 'string' && manifest.main.length > 0
      ? manifest.main
      : 'index.js';
    const mainPath = path.resolve(resolvedPluginRoot, requestedMain);
    if (!mainPath.startsWith(resolvedPluginRoot + path.sep) && mainPath !== resolvedPluginRoot) {
      throw new Error(
        `Plugin manifest.main escapes the plugin directory: ${requestedMain}`,
      );
    }

    // Load plugin code
    const pluginModule = await import(mainPath);

    // Register plugin
    const pluginId = await this.registerPlugin(manifest);

    // Store module reference
    this.pluginModules.set(pluginId, pluginModule);

    this.logger.log(`External plugin loaded: ${manifest.name} from ${resolvedPluginRoot}`);
  }

  /**
   * Handler names for external plugins are strings pulled from the plugin
   * manifest (pluginHook.handler). Without a safelist, `pluginModule[name]`
   * could resolve to prototype builtins (`__proto__`, `constructor`,
   * `toString`, …) and we'd happily call them with `(context, settings)`.
   */
  private isSafeHandlerName(name: string): boolean {
    if (typeof name !== 'string' || name.length === 0 || name.length > 128) return false;
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) return false;
    const BLOCKED = new Set([
      '__proto__',
      'constructor',
      'prototype',
      'hasOwnProperty',
      'isPrototypeOf',
      'propertyIsEnumerable',
      'toLocaleString',
      'toString',
      'valueOf',
    ]);
    return !BLOCKED.has(name);
  }

  private readonly pluginModules = new Map<string, any>();

  private async loadPluginModule(plugin: Plugin): Promise<any> {
    // Check if already loaded
    if (this.pluginModules.has(plugin.id)) {
      return this.pluginModules.get(plugin.id);
    }

    // For built-in plugins, return the instance
    switch (plugin.name) {
      case 'PII Filter':
        return new PiiFilterPlugin();
      case 'Rate Limiter':
        return new RateLimiterPlugin();
      case 'Request Logger':
        return new RequestLoggerPlugin();
      case 'Security Scanner':
        return new SecurityScannerPlugin();
      case 'Performance Monitor':
        return new PerformanceMonitorPlugin();
      default:
        throw new Error(`Plugin module not found: ${plugin.id}`);
    }
  }

  // Plugin Validation
  private async validatePlugin(plugin: Plugin): Promise<{
    isValid: boolean;
    errors: string[];
    warnings: string[];
  }> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Basic validation
    if (!plugin.name) {
      errors.push('Plugin name is required');
    }

    if (!plugin.version) {
      errors.push('Plugin version is required');
    }

    if (!plugin.hooks || plugin.hooks.length === 0) {
      warnings.push('Plugin has no hooks defined');
    }

    // Validate hook types
    for (const hook of plugin.hooks) {
      if (!Object.values(PluginHookType).includes(hook.type)) {
        errors.push(`Invalid hook type: ${hook.type}`);
      }
      
      if (!hook.handler) {
        errors.push(`Missing handler for hook: ${hook.type}`);
      }
    }

    // Security validation
    if (!this.config.allowUnsafePlugins) {
      // Check for unsafe operations
      if (plugin.capabilities.operations.includes('execute')) {
        warnings.push('Plugin has execute capabilities - ensure it is trusted');
      }
      
      if (plugin.configuration.security && !plugin.configuration.security.allowedHosts) {
        warnings.push('Plugin has network access but no host restrictions');
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  // Plugin Configuration Management
  private async loadPluginConfigurations(): Promise<void> {
    try {
      const configKeys = await this.redis.keys('plugin:config:*');
      
      for (const key of configKeys) {
        const config = await this.redis.get(key);
        if (config) {
          const pluginId = key.replace('plugin:config:', '');
          const plugin = this.registry.plugins.get(pluginId);
          
          if (plugin) {
            plugin.configuration = { ...plugin.configuration, ...JSON.parse(config) };
            this.registry.plugins.set(pluginId, plugin);
          }
        }
      }
    } catch (error) {
      this.logger.error(`Failed to load plugin configurations: ${error.message}`);
    }
  }

  async updatePluginConfiguration(
    pluginId: string,
    configuration: Partial<Plugin['configuration']>,
  ): Promise<boolean> {
    const plugin = this.registry.plugins.get(pluginId);
    if (!plugin) {
      return false;
    }

    // Update configuration
    plugin.configuration = { ...plugin.configuration, ...configuration };
    this.registry.plugins.set(pluginId, plugin);

    // Store in Redis
    await this.redis.setex(
      `plugin:config:${pluginId}`,
      86400,
      JSON.stringify(configuration)
    );

    this.logger.log(`Plugin configuration updated: ${pluginId}`);
    return true;
  }

  // Plugin Metrics and Monitoring
  private async updatePluginMetrics(
    pluginId: string,
    executionTime: number,
    success: boolean,
  ): Promise<void> {
    const plugin = this.registry.plugins.get(pluginId);
    if (!plugin) {
      return;
    }

    plugin.metadata.usageCount++;
    plugin.metadata.averageExecutionTime = (
      (plugin.metadata.averageExecutionTime * (plugin.metadata.usageCount - 1)) + executionTime
    ) / plugin.metadata.usageCount;

    if (!success) {
      const totalExecutions = plugin.metadata.usageCount;
      const errorCount = Math.round(plugin.metadata.errorRate * (totalExecutions - 1)) + 1;
      plugin.metadata.errorRate = errorCount / totalExecutions;
    }

    plugin.metadata.lastUpdated = new Date().toISOString();

    // Update in Redis
    await this.redis.setex(`plugin:${pluginId}`, 86400, JSON.stringify(plugin));
  }

  // Utility Methods
  private evaluateConditions(conditions: any[], context: PluginContext): boolean {
    // Simplified condition evaluation - in production would use a proper expression evaluator
    return true; // For now, always execute
  }

  /**
   * Race a promise against a timeout, clearing the timer on either path
   * so the timeout callback doesn't keep the event loop alive. The old
   * `createTimeout` helper returned a standalone promise whose setTimeout
   * fired unconditionally after N ms even after the real handler had
   * already resolved — the race "finished", but the timer handle was
   * leaked until it fired.
   */
  private runWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error('Plugin execution timeout');
        (error as any).name = 'TimeoutError';
        reject(error);
      }, ms);
    });

    return Promise.race([promise, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    }) as Promise<T>;
  }

  private async emitPluginEvent(
    pluginId: string,
    type: string,
    message: string,
    organizationId?: string,
  ): Promise<void> {
    const event: PluginEvent = {
      id: `event_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      pluginId,
      type: type as any,
      message,
      timestamp: new Date(),
      organizationId,
    };

    this.emit('pluginEvent', event);
    
    // Store in Redis
    await this.redis.lpush('plugin:events', JSON.stringify(event));
    await this.redis.ltrim('plugin:events', 0, 1000); // Keep last 1000 events
  }

  private setupEventHandlers(): void {
    this.on('pluginEvent', (event: PluginEvent) => {
      this.logger.debug(`Plugin event: ${event.type} - ${event.message} (${event.pluginId})`);
    });
  }

  // Public API
  getPlugin(pluginId: string): Plugin | null {
    return this.registry.plugins.get(pluginId) || null;
  }

  listPlugins(organizationId?: string): Plugin[] {
    if (organizationId) {
      const orgPluginIds = this.registry.byOrganization.get(organizationId) || [];
      const globalPluginIds = this.registry.globalPlugins;
      
      return [...orgPluginIds, ...globalPluginIds]
        .map(id => this.registry.plugins.get(id))
        .filter(Boolean) as Plugin[];
    }

    return Array.from(this.registry.plugins.values());
  }

  getPluginsByHook(hookType: PluginHookType): Plugin[] {
    const pluginIds = this.registry.byHook.get(hookType) || [];
    return pluginIds
      .map(id => this.registry.plugins.get(id))
      .filter(Boolean) as Plugin[];
  }

  async getPluginStats(): Promise<{
    totalPlugins: number;
    activePlugins: number;
    pluginsByHook: Record<string, number>;
    totalExecutions: number;
    averageExecutionTime: number;
  }> {
    const plugins = Array.from(this.registry.plugins.values());
    const activePlugins = plugins.filter(p => p.isActive);
    
    const pluginsByHook: Record<string, number> = {};
    for (const [hookType, pluginIds] of this.registry.byHook.entries()) {
      pluginsByHook[hookType] = pluginIds.length;
    }

    const totalExecutions = plugins.reduce((sum, p) => sum + p.metadata.usageCount, 0);
    const averageExecutionTime = totalExecutions > 0
      ? plugins.reduce((sum, p) => sum + (p.metadata.averageExecutionTime * p.metadata.usageCount), 0) / totalExecutions
      : 0;

    return {
      totalPlugins: plugins.length,
      activePlugins: activePlugins.length,
      pluginsByHook,
      totalExecutions,
      averageExecutionTime,
    };
  }

  async shutdown(): Promise<void> {
    this.logger.log('Shutting down Plugin Manager');
    
    // Clear all registries
    this.registry.plugins.clear();
    this.registry.byHook.clear();
    this.registry.byOrganization.clear();
    this.registry.globalPlugins.length = 0;

    this.logger.log('Plugin Manager shutdown complete');
  }
}