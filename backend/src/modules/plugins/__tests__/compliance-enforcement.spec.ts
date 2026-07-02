import { PluginManagerService } from '../plugin-manager.service';
import { PluginHookType } from '../types/plugin.types';

/**
 * EE hook seam: executeHook consults the optional
 * COMPLIANCE_ENFORCEMENT_HOOK — a plugin the org policy enforces runs even
 * when not individually enabled, with the policy's settings overrides
 * applied for that execution only. Without the hook (community build) the
 * inactive-plugin skip is unchanged.
 */
describe('PluginManagerService — compliance enforcement', () => {
  const redis: any = { get: jest.fn(), set: jest.fn(), keys: jest.fn().mockResolvedValue([]) };
  const store: any = {};

  const okResult = {
    success: true,
    data: {},
    metadata: { executionTime: 1, modifications: [] },
    nextAction: 'continue',
  };

  function makeService(hook?: any) {
    const service = new PluginManagerService(redis, store, undefined, hook);
    const executed: any[] = [];
    (service as any).executePlugin = jest.fn(async (plugin: any) => {
      executed.push(plugin);
      return okResult;
    });
    return { service, executed };
  }

  function register(service: PluginManagerService, plugin: {
    name: string;
    isActive: boolean;
    settings?: Record<string, any>;
    organizationId?: string;
  }) {
    const id = `plugin_${plugin.name.toLowerCase().replace(/\s+/g, '-')}`;
    const row: any = {
      id,
      name: plugin.name,
      isActive: plugin.isActive,
      organizationId: plugin.organizationId,
      configuration: { priority: 50, settings: plugin.settings ?? {} },
      hooks: [{ type: PluginHookType.PRE_REQUEST, handler: 'run' }],
    };
    (service as any).registry.plugins.set(id, row);
    const byHook: Map<string, string[]> = (service as any).registry.byHook;
    byHook.set(PluginHookType.PRE_REQUEST, [
      ...(byHook.get(PluginHookType.PRE_REQUEST) || []),
      id,
    ]);
    return id;
  }

  const ctx = (organizationId: string | null = 'org-1') =>
    ({
      hookType: PluginHookType.PRE_REQUEST,
      organizationId,
      userId: 'user-1',
      requestId: 'req-1',
      data: {},
      metadata: { timestamp: new Date().toISOString() },
    }) as any;

  it('community build (no hook): inactive plugins stay skipped', async () => {
    const { service, executed } = makeService();
    register(service, { name: 'Security Scanner', isActive: false });
    register(service, { name: 'Request Logger', isActive: true });

    await service.executeHook(PluginHookType.PRE_REQUEST, ctx());

    expect(executed.map((p) => p.name)).toEqual(['Request Logger']);
  });

  it('runs an enforced plugin even when not individually enabled, with policy settings', async () => {
    const hook = {
      getEnforcement: jest.fn(async () => ({
        enforcedPlugins: {
          'security-scanner': { severityThreshold: 'high', blockOnThreat: true },
        },
        blockOnViolation: true,
      })),
    };
    const { service, executed } = makeService(hook);
    register(service, {
      name: 'Security Scanner',
      isActive: false,
      settings: { severityThreshold: 'medium', blockOnThreat: false, scanDepth: 3 },
    });

    await service.executeHook(PluginHookType.PRE_REQUEST, ctx());

    expect(hook.getEnforcement).toHaveBeenCalledWith('org-1');
    expect(executed).toHaveLength(1);
    expect(executed[0].name).toBe('Security Scanner');
    // Policy overrides win; unrelated settings are preserved.
    expect(executed[0].configuration.settings).toEqual({
      severityThreshold: 'high',
      blockOnThreat: true,
      scanDepth: 3,
    });
  });

  it('applies policy overrides to an already-active enforced plugin without mutating the registry', async () => {
    const hook = {
      getEnforcement: jest.fn(async () => ({
        enforcedPlugins: {
          'security-scanner': { severityThreshold: 'critical', blockOnThreat: true },
        },
        blockOnViolation: true,
      })),
    };
    const { service, executed } = makeService(hook);
    const id = register(service, {
      name: 'Security Scanner',
      isActive: true,
      settings: { severityThreshold: 'low' },
    });

    await service.executeHook(PluginHookType.PRE_REQUEST, ctx());

    expect(executed[0].configuration.settings.severityThreshold).toBe('critical');
    // Registered configuration is untouched.
    const registered: any = (service as any).registry.plugins.get(id);
    expect(registered.configuration.settings.severityThreshold).toBe('low');
  });

  it('leaves non-enforced inactive plugins skipped', async () => {
    const hook = {
      getEnforcement: jest.fn(async () => ({
        enforcedPlugins: { 'pii-filter': {} },
        blockOnViolation: true,
      })),
    };
    const { service, executed } = makeService(hook);
    register(service, { name: 'PII Filter', isActive: false });
    register(service, { name: 'Security Scanner', isActive: false });

    await service.executeHook(PluginHookType.PRE_REQUEST, ctx());

    expect(executed.map((p) => p.name)).toEqual(['PII Filter']);
  });

  it('null enforcement (unlicensed / nothing enforced) behaves like community', async () => {
    const hook = { getEnforcement: jest.fn(async () => null) };
    const { service, executed } = makeService(hook);
    register(service, { name: 'Security Scanner', isActive: false });

    await service.executeHook(PluginHookType.PRE_REQUEST, ctx());

    expect(hook.getEnforcement).toHaveBeenCalled();
    expect(executed).toHaveLength(0);
  });

  it('a throwing hook behaves like community and never breaks the chain', async () => {
    const hook = { getEnforcement: jest.fn(async () => { throw new Error('boom'); }) };
    const { service, executed } = makeService(hook);
    register(service, { name: 'Security Scanner', isActive: false });
    register(service, { name: 'Request Logger', isActive: true });

    await service.executeHook(PluginHookType.PRE_REQUEST, ctx());

    expect(executed.map((p) => p.name)).toEqual(['Request Logger']);
  });

  it('skips enforcement without an organization context', async () => {
    const hook = { getEnforcement: jest.fn(async () => null) };
    const { service, executed } = makeService(hook);
    register(service, { name: 'Security Scanner', isActive: false });

    await service.executeHook(PluginHookType.PRE_REQUEST, ctx(null));

    expect(hook.getEnforcement).not.toHaveBeenCalled();
    expect(executed).toHaveLength(0);
  });
});
