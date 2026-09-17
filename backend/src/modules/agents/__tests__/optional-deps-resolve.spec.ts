import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * An @Optional() dependency still has to be importable.
 *
 * @Optional() is how a provider stays usable in harnesses that do not
 * build the whole graph. Its cost is silence: when the owning module is
 * not imported, the injection resolves to undefined and the feature
 * simply does nothing. That is exactly what happened — AgentsModule never
 * imported ModelCatalogModule, ModelRouterService is exported only there,
 * and every resolved role answered "routing is not available on this
 * install" as though a license were missing rather than an import.
 *
 * So each optional dependency this module relies on is checked against
 * the module that exports it. A unit test cannot see this: it passes its
 * own mock in.
 */
const MODULES = join(__dirname, '../..');

function source(path: string): string {
  return readFileSync(join(MODULES, path), 'utf8');
}

describe('agents module can actually resolve what it optionally injects', () => {
  const agentsModule = source('agents/agents.module.ts');

  const cases: Array<{ provider: string; exportedBy: string; module: string }> = [
    { provider: 'ModelRouterService', exportedBy: 'model-catalog/model-catalog.module.ts', module: 'ModelCatalogModule' },
    { provider: 'LlmProvidersService', exportedBy: 'llm-providers/llm-providers.module.ts', module: 'LlmProvidersModule' },
  ];

  it.each(cases)('$provider comes from $module, which agents imports', ({ provider, exportedBy, module }) => {
    // It is exported where we think it is...
    const owner = source(exportedBy);
    const exportsBlock = owner.match(/exports:\s*\[([\s\S]*?)\]/)?.[1] ?? '';
    expect(exportsBlock).toContain(provider);

    // ...and this module imports that module.
    const importsBlock = agentsModule.match(/imports:\s*\[([\s\S]*?)\n\s{2}\]/)?.[1] ?? agentsModule;
    expect(importsBlock).toContain(module);
  });

  it('names every optional injection it depends on, so this list cannot quietly fall behind', () => {
    // If a new @Optional() provider appears in these services, it belongs
    // in `cases` above with the module that exports it.
    const services = [source('agents/agent-roles.service.ts'), source('agents/strategies/orchestrator.service.ts')].join('\n');
    const optional = [...services.matchAll(/@Optional\(\)[\s\S]{0,120}?:\s*(\w+)/g)].map((m) => m[1]);

    const known = new Set([...cases.map((c) => c.provider), 'ModelCatalogService']);
    for (const dep of optional) expect(known.has(dep)).toBe(true);
  });
});
