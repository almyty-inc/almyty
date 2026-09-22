import { PluginManagerService } from '../plugin-manager.service';
import { PluginHookType } from '../types/plugin.types';

/**
 * A built-in plugin's handler is a prototype method, so it has to be
 * called ON its instance.
 *
 * `loadPluginModule` hands back `new Ctor()` for a built-in, and
 * `executePluginHandler` pulled the method off it and called it as a bare
 * function: `handlerFunction(context, settings)`. Class bodies are strict
 * mode, so `this` was `undefined` and the first `this.something(...)` in
 * the handler threw. The throw was swallowed into a `success: false`
 * result carrying the ORIGINAL data, and `executeHook` skips the
 * modification merge when a result is unsuccessful -- so the request went
 * through untouched and nothing was logged above debug.
 *
 * Net effect at the one hook the product invokes
 * (ToolExecutorService -> PRE_TOOL_EXECUTION): the PII filter redacted
 * nothing, the security scanner blocked nothing, and the request logger
 * logged nothing -- on every tool call, for every organization. Both
 * plugins the EE compliance pack can enforce are in that list, so
 * `compliance_pack` charged for controls that could not fire and scored
 * a posture out of them.
 */
describe('built-in plugin handlers execute bound to their instance', () => {
  function makeManager(enforced?: Record<string, Record<string, any>>) {
    const redis: any = {
      keys: jest.fn().mockResolvedValue([]),
      setex: jest.fn(),
      lpush: jest.fn(),
      ltrim: jest.fn(),
      del: jest.fn(),
    };
    const store: any = {
      loadPluginConfigurations: jest.fn(),
      updatePluginMetrics: jest.fn(),
    };
    const hook = enforced
      ? { getEnforcement: jest.fn(async () => ({ enforcedPlugins: enforced, blockOnViolation: true })) }
      : undefined;
    return new PluginManagerService(redis, store, undefined, hook as any);
  }

  const ctx = (data: Record<string, unknown>) =>
    ({
      hookType: PluginHookType.PRE_TOOL_EXECUTION,
      organizationId: 'org-1',
      userId: 'user-1',
      requestId: 'req-1',
      data,
      metadata: {
        timestamp: new Date().toISOString(),
        plugin: { id: '', name: '', version: '' },
        execution: { attempt: 1, timeout: 0, startTime: Date.now() },
      },
    }) as any;

  /** Keep only the named built-ins so one plugin cannot mask another. */
  function only(manager: PluginManagerService, names: string[]) {
    const registry: any = (manager as any).registry;
    for (const [id, plugin] of registry.plugins) {
      if (names.includes(plugin.name)) continue;
      registry.plugins.delete(id);
      for (const ids of registry.byHook.values()) {
        const i = ids.indexOf(id);
        if (i > -1) ids.splice(i, 1);
      }
    }
  }

  it('the PII filter an org enforces actually redacts the tool parameters', async () => {
    const manager = makeManager({ 'pii-filter': {} });
    await manager.initialize();
    only(manager, ['PII Filter']);

    const out = await manager.executeHook(
      PluginHookType.PRE_TOOL_EXECUTION,
      ctx({ note: 'reach me at alice@example.com' }),
    );

    expect(JSON.stringify(out.data)).not.toContain('alice@example.com');
    expect(out.metadata.halted).toBeUndefined();
  });

  it('the security scanner an org enforces actually halts the chain', async () => {
    const manager = makeManager({ 'security-scanner': {} });
    await manager.initialize();
    only(manager, ['Security Scanner']);

    const out = await manager.executeHook(
      PluginHookType.PRE_TOOL_EXECUTION,
      ctx({ q: "'; DROP TABLE users; --" }),
    );

    expect(out.metadata.halted).toMatchObject({
      pluginName: 'Security Scanner',
      code: 'SECURITY_THREAT_DETECTED',
    });
  });

  it('no built-in handler fails because it was called unbound', async () => {
    const manager = makeManager();
    await manager.initialize();

    const registry: any = (manager as any).registry;
    const failures: string[] = [];
    for (const plugin of registry.plugins.values()) {
      for (const hook of plugin.hooks) {
        const result = await (manager as any).executePluginHandler(
          plugin,
          hook.handler,
          ctx({ note: 'alice@example.com', q: 'select 1' }),
        );
        const message = result?.error?.message ?? '';
        if (/Cannot read properties of undefined/.test(message)) {
          failures.push(`${plugin.name}.${hook.handler}: ${message}`);
        }
      }
    }

    expect(failures).toEqual([]);
  });
});
