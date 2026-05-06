import { Plugin, PluginContext, PluginHookType } from './types/plugin.types';

/**
 * Race a promise against a timeout, clearing the timer on either path
 * so the timeout callback doesn't keep the event loop alive past
 * resolution. The previous implementation leaked timer handles for up
 * to `ms` after the handler had already settled.
 */
export function runWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
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

export function evaluateConditions(_conditions: any[], _context: PluginContext): boolean {
  // Simplified condition evaluation — production would use a proper
  // expression evaluator. For now plugins always run.
  return true;
}

export interface PluginValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

export function validatePlugin(plugin: Plugin, allowUnsafePlugins: boolean): PluginValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!plugin.name) errors.push('Plugin name is required');
  if (!plugin.version) errors.push('Plugin version is required');

  if (!plugin.hooks || plugin.hooks.length === 0) {
    warnings.push('Plugin has no hooks defined');
  }

  for (const hook of plugin.hooks) {
    if (!Object.values(PluginHookType).includes(hook.type)) {
      errors.push(`Invalid hook type: ${hook.type}`);
    }
    if (!hook.handler) {
      errors.push(`Missing handler for hook: ${hook.type}`);
    }
  }

  if (!allowUnsafePlugins) {
    if (plugin.capabilities.operations.includes('execute')) {
      warnings.push('Plugin has execute capabilities - ensure it is trusted');
    }
    if (plugin.configuration.security && !plugin.configuration.security.allowedHosts) {
      warnings.push('Plugin has network access but no host restrictions');
    }
  }

  return { isValid: errors.length === 0, errors, warnings };
}
