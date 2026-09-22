import { readFileSync } from 'fs';
import { join } from 'path';

import { PluginManagerService } from '../../../../src/modules/plugins/plugin-manager.service';
import { PluginLoaderHelper } from '../../../../src/modules/plugins/plugin-loader.helper';
import { PluginHookType } from '../../../../src/modules/plugins/types/plugin.types';
import { PiiFilterPlugin } from '../../../../src/modules/plugins/built-in/pii-filter.plugin';
import { SecurityScannerPlugin } from '../../../../src/modules/plugins/built-in/security-scanner.plugin';
import type { EnforceablePlugin } from '../../../../src/entities/compliance-policy.entity';

/**
 * The compliance pack sells "enforced org-wide". A plugin it enforces has
 * to have a hook at a point something actually invokes.
 *
 * `executeHook` is called from exactly one place in the product --
 * `ToolExecutorService.execute`, with PRE_TOOL_EXECUTION. The PII filter
 * advertised PRE_TOOL_EXECUTION in `capabilities.hooks` but never put an
 * entry for it in `hooks`, and `registerPlugin` builds `registry.byHook`
 * from `hooks`. So the filter was not in the list for the only hook type
 * anyone runs: an org on the compliance pack could enforce `pii-filter`,
 * read `enforced: true` back out of its compliance report and collect 40
 * of its 100 posture points for a control that could not run on a single
 * request.
 *
 * The unit tests missed it because they registered fabricated plugins on
 * PRE_REQUEST -- a hook type nothing calls -- instead of the real
 * built-in definitions on the hook type the executor uses.
 */
describe('compliance-pack enforceable plugins are reachable', () => {
  const ENFORCEABLE: EnforceablePlugin[] = ['pii-filter', 'security-scanner'];

  const definitions: Record<EnforceablePlugin, any> = {
    'pii-filter': new PiiFilterPlugin().getPluginDefinition(),
    'security-scanner': new SecurityScannerPlugin().getPluginDefinition(),
  };

  /** The hook type the product actually invokes, read off the call site. */
  const invokedHookTypes = (() => {
    const src = readFileSync(
      join(__dirname, '../../../../src/modules/tools/tool-executor.service.ts'),
      'utf8',
    );
    const calls = src.match(/executeHook\(\s*PluginHookType\.([A-Z_]+)/g) ?? [];
    return [...new Set(calls.map((c) => c.replace(/^.*PluginHookType\./, '')))];
  })();

  it('finds the call site, so this guard cannot pass by matching nothing', () => {
    expect(invokedHookTypes).toEqual(['PRE_TOOL_EXECUTION']);
  });

  it.each(ENFORCEABLE)('%s registers a hook at a point that is invoked', (key) => {
    const registered: string[] = definitions[key].hooks.map((h: any) => String(h.type));
    const reachable = invokedHookTypes.filter((t) =>
      registered.includes((PluginHookType as any)[t]),
    );

    expect(reachable).not.toEqual([]);
  });

  it.each(ENFORCEABLE)('%s registers every hook it advertises as a capability', (key) => {
    const advertised: string[] = definitions[key].capabilities.hooks.map(String);
    const registered: string[] = definitions[key].hooks.map((h: any) => String(h.type));

    // Only the invoked ones are load-bearing; an advertised hook nobody
    // calls is dead either way.
    const missing = advertised
      .filter((t) => invokedHookTypes.includes(
        Object.keys(PluginHookType).find((k) => (PluginHookType as any)[k] === t) ?? '',
      ))
      .filter((t) => !registered.includes(t));

    expect(missing).toEqual([]);
  });

  it('an enforced PII filter actually redacts tool parameters', async () => {
    const redis: any = { keys: jest.fn().mockResolvedValue([]), setex: jest.fn(), lpush: jest.fn(), ltrim: jest.fn(), del: jest.fn() };
    const store: any = {
      loadPluginConfigurations: jest.fn(),
      updatePluginMetrics: jest.fn(),
    };
    const complianceHook = {
      getEnforcement: jest.fn(async () => ({
        enforcedPlugins: { 'pii-filter': {} },
        blockOnViolation: true,
      })),
    };

    const manager = new PluginManagerService(redis, store, undefined, complianceHook as any);
    // Only the PII filter, so nothing else can be the one that answers.
    (manager as any).loader = new (class extends PluginLoaderHelper {
      async loadBuiltInPlugins(register: any) {
        await register(new PiiFilterPlugin().getPluginDefinition());
      }
      async loadExternalPlugins() {}
    })();
    await manager.initialize();

    const out = await manager.executeHook(PluginHookType.PRE_TOOL_EXECUTION, {
      hookType: PluginHookType.PRE_TOOL_EXECUTION,
      organizationId: 'org-1',
      userId: 'user-1',
      requestId: 'req-1',
      data: { note: 'reach me at alice@example.com' },
      metadata: { timestamp: new Date().toISOString() } as any,
    } as any);

    expect(JSON.stringify(out.data)).not.toContain('alice@example.com');
  });
});
