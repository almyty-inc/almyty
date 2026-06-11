import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Optional } from '@nestjs/common';
import { EventEmitter } from 'events';
import { InjectRedis } from '@nestjs-modules/ioredis';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as Redis from 'ioredis';

import { UsageMetric, MetricType, MetricStatus } from '../../entities/usage-metric.entity';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';

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

import { PluginLoaderHelper, isSafeHandlerName } from './plugin-loader.helper';
import { PluginStoreHelper } from './plugin-store.helper';
import * as pluginUtils from './plugin-utils';
import { evaluateConditions, runWithTimeout, validatePlugin } from './plugin-utils';

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
  private readonly loader: PluginLoaderHelper;
  private readonly config: PluginManagerConfig = {
    maxConcurrentExecutions: 10,
    defaultTimeout: 30000,
    enableSandbox: true,
    allowUnsafePlugins: false,
    pluginDirectory: path.join(process.cwd(), 'plugins'),
  };

  constructor(
    @InjectRedis() private readonly redis: Redis.Redis,
    private readonly store: PluginStoreHelper,
    // Optional so unit tests (and any DB-less context) construct the manager
    // without a repository; security counters are simply not recorded then.
    @Optional()
    @InjectRepository(UsageMetric)
    private readonly usageMetricRepository?: Repository<UsageMetric>,
  ) {
    super();
    // Construct the loader with our Redis client so built-in plugins (the
    // rate limiter) can share counters across replicas.
    this.loader = new PluginLoaderHelper(this.redis);
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
      await this.loader.loadBuiltInPlugins(this.registerPlugin.bind(this));
      
      // Load external plugins from directory
      await this.loader.loadExternalPlugins(this.registerPlugin.bind(this), this.config.pluginDirectory!);
      
      // Load plugin configurations from Redis
      await this.store.loadPluginConfigurations(this.registry);
      
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

        this.recordSecurityCounters(plugin, pluginResult, currentContext);

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

  /**
   * Record security telemetry from a plugin result so the monitoring
   * dashboard reflects real activity (these used to be hard-coded zeros).
   *
   * - A blocked threat is self-identifying via the result error code, so any
   *   plugin that blocks on a detected threat is counted.
   * - PII redactions come from the built-in PII Filter, which reports each
   *   redaction in `modifications`.
   *
   * Writes are fire-and-forget and no-op when no repository is wired.
   */
  private recordSecurityCounters(
    plugin: Plugin,
    result: PluginResult,
    context: PluginContext,
  ): void {
    if (!this.usageMetricRepository) return;

    if (result?.error?.code === 'SECURITY_THREAT_DETECTED') {
      const threats = result.error.details?.threats;
      const count = Array.isArray(threats) && threats.length > 0 ? threats.length : 1;
      this.recordMetric(MetricType.SECURITY_THREAT_BLOCKED, count, context);
    }

    if (plugin?.name === 'PII Filter' && result?.success) {
      const redactions = result.metadata?.modifications?.length ?? 0;
      if (redactions > 0) {
        this.recordMetric(MetricType.PII_FILTERED, redactions, context);
      }
    }
  }

  private recordMetric(type: MetricType, value: number, context: PluginContext): void {
    const metric = new UsageMetric();
    metric.type = type;
    metric.value = value;
    metric.status = MetricStatus.SUCCESS;
    metric.organizationId = context.organizationId || null;
    metric.userId = context.userId || null;
    metric.timestamp = new Date();
    metric.metadata = { requestId: context.requestId };
    this.usageMetricRepository!.save(metric).catch((err) =>
      this.logger.warn(`Failed to record ${type} metric: ${err.message}`),
    );
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
      if (pluginHook.conditions && !pluginUtils.evaluateConditions(pluginHook.conditions, context)) {
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
      await this.store.updatePluginMetrics(this.registry, plugin.id, Date.now() - startTime, result.success);

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
      if (!isSafeHandlerName(handlerName)) {
        throw new Error(`Unsafe or invalid handler name: ${handlerName}`);
      }

      // Load plugin module
      const pluginModule = await this.loader.loadPluginModule(plugin);

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
      const result: any = await runWithTimeout<any>(
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
    // Unguessable plugin id. The old shape was
    // `plugin_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    // — predictable timestamp prefix + non-cryptographic suffix. The
    // manager keys several in-memory Maps (pluginModules,
    // executionSemaphore, registry.byOrganization) by this id, so a
    // guessable value let a caller who brute-forces the id collide
    // with a real plugin's semaphore counter. Swap to
    // crypto.randomBytes(16) for 128 bits of entropy, consistent with
    // every other id in this codebase.
    const pluginId = `plugin_${crypto.randomBytes(16).toString('hex')}`;
    
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
    const validation = validatePlugin(plugin, this.config.allowUnsafePlugins ?? false);
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
    this.loader.forget(pluginId);
    this.executionSemaphore.delete(pluginId);

    // Emit plugin event
    await this.emitPluginEvent(pluginId, 'uninstalled', 'Plugin unregistered', plugin.organizationId);

    this.logger.log(`Plugin unregistered: ${pluginId}`);
    return true;
  }

  private async emitPluginEvent(
    pluginId: string,
    type: string,
    message: string,
    organizationId?: string,
  ): Promise<void> {
    const event: PluginEvent = {
      // Event ids are written into Redis (plugin:events) and returned
      // to dashboards as audit entries. Unguessable so a caller can't
      // enumerate the recent-events feed by crafting id guesses.
      id: `event_${crypto.randomBytes(16).toString('hex')}`,
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


  // ── Delegations to PluginStoreHelper ──
  updatePluginConfiguration(pluginId: string, configuration: Partial<Plugin['configuration']>) {
    return this.store.updatePluginConfiguration(this.registry, pluginId, configuration);
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