import { Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';

import { Plugin } from './types/plugin.types';
import { PiiFilterPlugin } from './built-in/pii-filter.plugin';
import { RateLimiterPlugin } from './built-in/rate-limiter.plugin';
import { RequestLoggerPlugin } from './built-in/request-logger.plugin';
import { SecurityScannerPlugin } from './built-in/security-scanner.plugin';
import { PerformanceMonitorPlugin } from './built-in/performance-monitor.plugin';

/**
 * Loader for built-in and external plugins. Owns the
 * `pluginModules` cache (resolved JS modules keyed by plugin id).
 *
 * The actual registration is up to the caller via the
 * `register` callback so this stays free of references to the
 * full PluginManagerService and avoids a circular dep.
 */

export type RegisterPluginFn = (
  pluginData: Omit<Plugin, 'id' | 'metadata'>,
) => Promise<string>;

const BLOCKED_HANDLER_NAMES = new Set([
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

/**
 * Handler names for external plugins are strings pulled from the plugin
 * manifest (pluginHook.handler). Without a safelist, `pluginModule[name]`
 * could resolve to prototype builtins (`__proto__`, `constructor`,
 * `toString`, …) and we'd happily call them with `(context, settings)`.
 */
export function isSafeHandlerName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0 || name.length > 128) return false;
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) return false;
  return !BLOCKED_HANDLER_NAMES.has(name);
}

export class PluginLoaderHelper {
  private readonly logger = new Logger(PluginLoaderHelper.name);
  private readonly pluginModules = new Map<string, any>();

  async loadBuiltInPlugins(register: RegisterPluginFn): Promise<void> {
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
        await register(plugin);
        this.logger.log(`Built-in plugin loaded: ${plugin.name}`);
      } catch (error: any) {
        this.logger.error(`Failed to load built-in plugin: ${error.message}`);
      }
    }
  }

  async loadExternalPlugins(
    register: RegisterPluginFn,
    pluginDirectory: string,
  ): Promise<void> {
    try {
      const exists = await fs.access(pluginDirectory).then(() => true).catch(() => false);

      if (!exists) {
        this.logger.log('Plugin directory not found - skipping external plugin loading');
        return;
      }

      const entries = await fs.readdir(pluginDirectory, { withFileTypes: true });
      const pluginDirs = entries.filter((entry) => entry.isDirectory());

      for (const dir of pluginDirs) {
        try {
          await this.loadExternalPlugin(register, path.join(pluginDirectory, dir.name));
        } catch (error: any) {
          this.logger.error(`Failed to load external plugin ${dir.name}: ${error.message}`);
        }
      }
    } catch (error: any) {
      this.logger.error(`Failed to load external plugins: ${error.message}`);
    }
  }

  async loadExternalPlugin(register: RegisterPluginFn, pluginPath: string): Promise<void> {
    const resolvedPluginRoot = path.resolve(pluginPath);

    const manifestPath = path.join(resolvedPluginRoot, 'plugin.json');
    const manifestContent = await fs.readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(manifestContent);

    // Resolve + confine manifest.main. `main` is user-controlled — a
    // manifest with `"main": "../../node_modules/whatever/index.js"`
    // would happily `import()` code from outside the plugin directory.
    const requestedMain =
      typeof manifest.main === 'string' && manifest.main.length > 0
        ? manifest.main
        : 'index.js';
    const mainPath = path.resolve(resolvedPluginRoot, requestedMain);
    if (
      !mainPath.startsWith(resolvedPluginRoot + path.sep) &&
      mainPath !== resolvedPluginRoot
    ) {
      throw new Error(`Plugin manifest.main escapes the plugin directory: ${requestedMain}`);
    }

    const pluginModule = await import(mainPath);

    const pluginId = await register(manifest);

    this.pluginModules.set(pluginId, pluginModule);

    this.logger.log(`External plugin loaded: ${manifest.name} from ${resolvedPluginRoot}`);
  }

  /**
   * Resolve a plugin's module — either a previously loaded external
   * module, or the built-in plugin's module shape. Built-in plugins
   * have no on-disk file, so we fall back to constructing a fresh
   * instance and exposing its method-bag.
   */
  async loadPluginModule(plugin: Plugin): Promise<any> {
    const cached = this.pluginModules.get(plugin.id);
    if (cached) return cached;

    // Built-in lookup. Plugins identify themselves by `name` in the
    const builtIns: Record<string, any> = {
      'PII Filter': PiiFilterPlugin,
      'Rate Limiter': RateLimiterPlugin,
      'Request Logger': RequestLoggerPlugin,
      'Security Scanner': SecurityScannerPlugin,
      'Performance Monitor': PerformanceMonitorPlugin,
    };

    const Ctor = builtIns[plugin.name];
    if (Ctor) {
      const instance = new Ctor();
      this.pluginModules.set(plugin.id, instance);
      return instance;
    }

    throw new Error(`Plugin module not found: ${plugin.id}`);
  }

  forget(pluginId: string): void {
    this.pluginModules.delete(pluginId);
  }
}
