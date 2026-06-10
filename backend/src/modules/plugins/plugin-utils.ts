import { Plugin, PluginContext, PluginCondition, PluginHookType } from './types/plugin.types';

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

/**
 * Resolve a dot-path (e.g. `data.user.role`) against the plugin context.
 * Looks in `context.data` first, then the context root, using own-property
 * traversal only (no prototype walk). Returns undefined if any segment is
 * missing.
 */
function resolveField(field: string, context: PluginContext): unknown {
  const read = (root: any): unknown => {
    let cur = root;
    for (const seg of field.split('.')) {
      if (cur == null || typeof cur !== 'object') return undefined;
      if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
      cur = cur[seg];
    }
    return cur;
  };
  const fromData = read((context as any).data);
  return fromData !== undefined ? fromData : read(context);
}

// Cap the input length we run a user-supplied regex against. Plugin
// conditions are author-defined (semi-trusted), but bounding the subject
// length keeps a pathological pattern from turning into a ReDoS stall.
const MAX_REGEX_INPUT = 10_000;

function evaluateOne(condition: PluginCondition, context: PluginContext): boolean {
  const actual = resolveField(condition.field, context);
  switch (condition.type) {
    case 'equals':
      return actual === condition.value || String(actual) === String(condition.value);
    case 'contains':
      if (Array.isArray(actual)) return actual.includes(condition.value);
      return String(actual ?? '').includes(String(condition.value));
    case 'regex':
      try {
        const subject = String(actual ?? '').slice(0, MAX_REGEX_INPUT);
        return new RegExp(condition.value).test(subject);
      } catch {
        // An invalid pattern can't match anything — fail the condition
        // rather than throwing out of the hook dispatch.
        return false;
      }
    case 'custom':
    default:
      // No safe in-process evaluator for arbitrary custom predicates;
      // don't silently block the hook on a type we can't evaluate.
      return true;
  }
}

/**
 * Evaluate a plugin hook's conditions. All conditions must pass (AND) by
 * default; if any condition declares `operator: 'or'`, the set is treated
 * as OR (at least one must pass). An empty/absent list passes.
 */
export function evaluateConditions(
  conditions: PluginCondition[] | undefined,
  context: PluginContext,
): boolean {
  if (!conditions || conditions.length === 0) return true;
  const anyOr = conditions.some((c) => c.operator === 'or');
  return anyOr
    ? conditions.some((c) => evaluateOne(c, context))
    : conditions.every((c) => evaluateOne(c, context));
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
