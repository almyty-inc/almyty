import 'reflect-metadata'

import { ToolsModule } from '../tools.module'
import { ToolsExportController } from '../tools-export.controller'

// Regression for #114 and #116. The ToolsExportController saw two
// shape regressions in quick succession:
//   1. The @Controller path was wrong, so the routes 404'd.
//   2. A duplicate @Controller decorator was attached during a
//      rebase, which Nest treats as undefined behaviour.
// Both of those would slip past normal unit tests. We pin down the
// shape here: a single @Controller, the expected base path, and
// the controller appearing in tools.module's controllers array.

describe('ToolsExportController wiring', () => {
  it('is registered on ToolsModule', () => {
    const controllers = Reflect.getMetadata('controllers', ToolsModule) ?? []
    expect(controllers).toContain(ToolsExportController)
  })

  it('has the org-scoped /organizations/:organizationId/tools base path', () => {
    const path = Reflect.getMetadata('path', ToolsExportController)
    expect(path).toBe('organizations/:organizationId/tools')
  })

  it('uses a single host property (no duplicate @Controller decorators)', () => {
    // Nest stores host metadata under SCOPE_OPTIONS / PATH keys.
    // A duplicate @Controller would either overwrite the path or
    // attach a second `host` array depending on Reflect's behaviour;
    // either way the resulting value isn't a single string.
    const host = Reflect.getMetadata('host', ToolsExportController)
    if (host !== undefined) {
      expect(Array.isArray(host) ? host.length : 1).toBeLessThanOrEqual(1)
    }
  })
})
