import 'reflect-metadata'

import { AgentsModule } from '../modules/agents/agents.module'
import { LlmProvidersModule } from '../modules/llm-providers/llm-providers.module'
import { ToolsModule } from '../modules/tools/tools.module'
import { McpModule } from '../modules/mcp/mcp.module'
import { GatewaysModule } from '../modules/gateways/gateways.module'
import { OrganizationsModule } from '../modules/organizations/organizations.module'
import { MemoryModule } from '../modules/memory/memory.module'
import { UnifiedEndpointModule } from '../modules/gateways/unified-endpoint.module'
import { RunnerModule } from '../modules/runner/runner.module'

// Regression for #91. The boot regression that crash-looped staging
// for four days came from missing forwardRef edges on
// LlmProvidersModule ↔ ToolsModule and McpModule ↔ GatewaysModule.
// A full Nest bootstrap is too heavy for a unit spec, but we can lock
// the topology at the module-metadata level so a refactor that strips
// a forwardRef fails CI instead of crash-looping staging.

function importsOf(module: any): any[] {
  return Reflect.getMetadata('imports', module) ?? []
}

// Nest stores forwardRef'd imports as { forwardRef: () => Module };
// the static reference is the same identity as the eagerly-imported
// target, so this resolves both forms uniformly.
function resolveImport(entry: any): any {
  if (entry && typeof entry === 'object' && typeof entry.forwardRef === 'function') {
    try {
      return entry.forwardRef()
    } catch {
      return entry
    }
  }
  return entry
}

describe('DI cycle topology (#91)', () => {
  const cases: Array<{ name: string; module: any; expects: any[] }> = [
    { name: 'AgentsModule', module: AgentsModule, expects: [LlmProvidersModule, ToolsModule] },
    { name: 'LlmProvidersModule', module: LlmProvidersModule, expects: [ToolsModule] },
    { name: 'McpModule', module: McpModule, expects: [ToolsModule, GatewaysModule] },
    { name: 'UnifiedEndpointModule', module: UnifiedEndpointModule, expects: [McpModule] },
    { name: 'OrganizationsModule', module: OrganizationsModule, expects: [GatewaysModule] },
    { name: 'MemoryModule', module: MemoryModule, expects: [LlmProvidersModule] },
    { name: 'RunnerModule', module: RunnerModule, expects: [McpModule] },
  ]

  it.each(cases)('$name imports include all forwardRef edges', ({ module, expects }) => {
    const resolved = importsOf(module).map(resolveImport)
    for (const expected of expects) {
      expect(resolved).toContain(expected)
    }
  })
})
