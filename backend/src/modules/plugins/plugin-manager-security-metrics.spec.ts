import { PluginManagerService } from './plugin-manager.service';
import { MetricType } from '../../entities/usage-metric.entity';
import { PluginHookType } from './types/plugin.types';

/**
 * The manager records security telemetry (threats blocked, PII redacted) as
 * usage_metrics rows so the monitoring dashboard shows real activity. These
 * tests drive executeHook directly with hand-registered plugins.
 */
describe('PluginManagerService — security counters', () => {
  let service: PluginManagerService;
  let saved: any[];

  const redis: any = { get: jest.fn(), set: jest.fn(), keys: jest.fn().mockResolvedValue([]) };
  const store: any = {};

  // A plugin whose registered handler returns a canned PluginResult.
  function register(name: string, result: any): string {
    const id = `plugin_${name}`;
    const plugin: any = {
      id,
      name,
      isActive: true,
      configuration: { priority: 50 },
      hooks: [{ type: PluginHookType.PRE_REQUEST, handler: 'run' }],
    };
    (service as any).registry.plugins.set(id, plugin);
    const byHook: Map<string, string[]> = (service as any).registry.byHook;
    byHook.set(PluginHookType.PRE_REQUEST, [
      ...(byHook.get(PluginHookType.PRE_REQUEST) || []),
      id,
    ]);
    // Stub the per-plugin executor to return our canned result.
    const orig = (service as any).executePlugin.bind(service);
    (service as any).executePlugin = jest.fn(async (p: any) =>
      p.id === id ? result : orig(p),
    );
    return id;
  }

  const ctx = () =>
    ({
      hookType: PluginHookType.PRE_REQUEST,
      organizationId: 'org-1',
      userId: 'user-1',
      requestId: 'req-1',
      data: {},
      metadata: { timestamp: new Date().toISOString() },
    }) as any;

  beforeEach(() => {
    saved = [];
    const repo: any = {
      save: jest.fn((m: any) => {
        saved.push(m);
        return Promise.resolve(m);
      }),
    };
    service = new PluginManagerService(redis, store, repo);
  });

  it('records a threat-blocked metric when a plugin blocks on a detected threat', async () => {
    register('Security Scanner', {
      success: false,
      data: {},
      error: {
        code: 'SECURITY_THREAT_DETECTED',
        message: 'blocked',
        details: { threats: [{ type: 'xss' }, { type: 'sql_injection' }], blocked: true },
      },
      metadata: { executionTime: 1, modifications: [] },
      nextAction: 'stop',
    });

    await service.executeHook(PluginHookType.PRE_REQUEST, ctx());

    expect(saved).toHaveLength(1);
    expect(saved[0].type).toBe(MetricType.SECURITY_THREAT_BLOCKED);
    expect(saved[0].value).toBe(2); // two threats in the block
    expect(saved[0].organizationId).toBe('org-1');
  });

  it('records a PII-filtered metric counting redactions from the PII Filter', async () => {
    register('PII Filter', {
      success: true,
      data: {},
      metadata: { executionTime: 1, modifications: ['email', 'ssn', 'phone'] },
      nextAction: 'continue',
    });

    await service.executeHook(PluginHookType.PRE_REQUEST, ctx());

    expect(saved).toHaveLength(1);
    expect(saved[0].type).toBe(MetricType.PII_FILTERED);
    expect(saved[0].value).toBe(3);
  });

  it('records nothing when the PII Filter made no redactions', async () => {
    register('PII Filter', {
      success: true,
      data: {},
      metadata: { executionTime: 1, modifications: [] },
      nextAction: 'continue',
    });

    await service.executeHook(PluginHookType.PRE_REQUEST, ctx());

    expect(saved).toHaveLength(0);
  });

  it('does not throw when no repository is wired (optional dependency)', async () => {
    service = new PluginManagerService(redis, store, undefined);
    register('Security Scanner', {
      success: false,
      data: {},
      error: { code: 'SECURITY_THREAT_DETECTED', details: { threats: [{ type: 'xss' }] } },
      metadata: { executionTime: 1, modifications: [] },
      nextAction: 'stop',
    });

    await expect(
      service.executeHook(PluginHookType.PRE_REQUEST, ctx()),
    ).resolves.toBeDefined();
  });
});
