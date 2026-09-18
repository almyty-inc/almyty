import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Every built-in plugin -- pii-filter, security-scanner, rate-limiter,
 * request-logger, performance-monitor -- was registered and invoked by
 * nothing. `executeHook` is the only entry point that runs a plugin, and a
 * repo-wide grep across src and ee found no caller: PluginManagerService was
 * injected into no class at all.
 *
 * So the EE compliance pack's "enforced org-wide" plugins never ran on a
 * single request, and the usage_metric security counters documented as
 * "emitted by PluginManager.executeHook" were always zero. The product
 * claimed a protection it did not apply, and nothing failed, because a
 * filter that never runs looks exactly like a filter that never matched.
 *
 * Source-reading on purpose: the failure mode is the absence of a call, and
 * a behavioural test on the executor passes just as happily without one.
 */
const executor = readFileSync(join(__dirname, '..', 'tool-executor.service.ts'), 'utf8');
const manager = readFileSync(
  join(__dirname, '..', '..', 'plugins', 'plugin-manager.service.ts'),
  'utf8',
);

describe('plugins actually run on the tool execution path', () => {
  it('the executor invokes the pre-tool hook', () => {
    expect(executor).toContain('this.pluginManager.executeHook(PluginHookType.PRE_TOOL_EXECUTION');
  });

  it('runs the hook after validation and sanitization, not before', () => {
    const sanitize = executor.indexOf('sanitizeToolParameters(parameters)');
    const hook = executor.indexOf('executeHook(PluginHookType.PRE_TOOL_EXECUTION');
    expect(sanitize).toBeGreaterThan(-1);
    expect(hook).toBeGreaterThan(sanitize);
  });

  it('runs the hook before anything dispatches the tool', () => {
    const hook = executor.indexOf('executeHook(PluginHookType.PRE_TOOL_EXECUTION');
    const dispatch = executor.indexOf('await this.executeRunnerCall(tool,');
    expect(dispatch).toBeGreaterThan(hook);
  });

  it('refuses the call when a plugin halts the chain', () => {
    expect(executor).toContain('if (halted)');
    expect(executor).toContain('throw new ForbiddenException');
  });

  it('sends the rewritten parameters onward, so a filter plugin is not decorative', () => {
    expect(executor).toContain('if (hooked.data !== undefined) parameters = hooked.data;');
  });

  it('keeps the plugin manager optional, so an install without it still runs tools', () => {
    expect(executor).toContain('@Optional() private readonly pluginManager?: PluginManagerService');
    expect(executor).toContain('if (this.pluginManager) {');
  });
});

describe('a halting plugin can tell its caller', () => {
  it('executeHook records the halt on the context it returns', () => {
    // executeHook returns only the context, so without this a caller cannot
    // distinguish a chain that ran clean from one a plugin stopped -- which
    // would make a blocking plugin unable to block even once wired up.
    expect(manager).toContain('currentContext.metadata.halted = {');
  });

  it('carries the plugin name and an error code, not just a boolean', () => {
    const block = manager.slice(
      manager.indexOf('currentContext.metadata.halted = {'),
      manager.indexOf('currentContext.metadata.halted = {') + 400,
    );
    expect(block).toContain('pluginName');
    expect(block).toContain('code');
    expect(block).toContain('message');
  });
});
