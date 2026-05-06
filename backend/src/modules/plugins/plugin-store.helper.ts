import { Injectable, Logger } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import * as Redis from 'ioredis';

import { Plugin, PluginRegistry } from './types/plugin.types';

/**
 * Redis-backed config + metrics persistence for plugins. Pulled
 * out of PluginManagerService so the manager can stay focused on
 * the hook execution loop and registration. The registry passed in
 * is owned by the manager — this helper only mutates entries when
 * Redis returns config or new metrics.
 */
@Injectable()
export class PluginStoreHelper {
  private readonly logger = new Logger(PluginStoreHelper.name);

  constructor(@InjectRedis() private readonly redis: Redis.Redis) {}

  async loadPluginConfigurations(registry: PluginRegistry): Promise<void> {
    try {
      const configKeys = await this.redis.keys('plugin:config:*');

      for (const key of configKeys) {
        const config = await this.redis.get(key);
        if (config) {
          const pluginId = key.replace('plugin:config:', '');
          const plugin = registry.plugins.get(pluginId);

          if (plugin) {
            plugin.configuration = { ...plugin.configuration, ...JSON.parse(config) };
            registry.plugins.set(pluginId, plugin);
          }
        }
      }
    } catch (error: any) {
      this.logger.error(`Failed to load plugin configurations: ${error.message}`);
    }
  }

  async updatePluginConfiguration(
    registry: PluginRegistry,
    pluginId: string,
    configuration: Partial<Plugin['configuration']>,
  ): Promise<boolean> {
    const plugin = registry.plugins.get(pluginId);
    if (!plugin) {
      return false;
    }

    plugin.configuration = { ...plugin.configuration, ...configuration };
    registry.plugins.set(pluginId, plugin);

    await this.redis.setex(
      `plugin:config:${pluginId}`,
      86400,
      JSON.stringify(configuration),
    );

    this.logger.log(`Plugin configuration updated: ${pluginId}`);
    return true;
  }

  async updatePluginMetrics(
    registry: PluginRegistry,
    pluginId: string,
    executionTime: number,
    success: boolean,
  ): Promise<void> {
    const plugin = registry.plugins.get(pluginId);
    if (!plugin) {
      return;
    }

    plugin.metadata.usageCount++;
    plugin.metadata.averageExecutionTime =
      (plugin.metadata.averageExecutionTime * (plugin.metadata.usageCount - 1) +
        executionTime) /
      plugin.metadata.usageCount;

    if (!success) {
      const totalExecutions = plugin.metadata.usageCount;
      const errorCount = Math.round(plugin.metadata.errorRate * (totalExecutions - 1)) + 1;
      plugin.metadata.errorRate = errorCount / totalExecutions;
    }

    plugin.metadata.lastUpdated = new Date().toISOString();

    await this.redis.setex(`plugin:${pluginId}`, 86400, JSON.stringify(plugin));
  }
}
