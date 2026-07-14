import 'reflect-metadata'

import { AppModule } from '../app.module'
import { VersionsModule } from '../modules/versions/versions.module'
import { UnifiedEndpointModule } from '../modules/gateways/unified-endpoint.module'

/**
 * Regression: the entity Change History (typeorm-versions) panel — e.g. the
 * agent version history — was permanently empty because GET
 * /versions/:entityType/:entityId returned 404. Two compounding causes:
 *
 *   1. VersionsModule was imported as a symbol in app.module but never added
 *      to the @Module imports array, so VersionsController was never mounted.
 *   2. UnifiedEndpointModule mounts a greedy root catch-all
 *      (@All(':orgSlug/:resourceSlug/*')). Even once VersionsModule is
 *      registered, its routes only win if it is registered BEFORE the
 *      catch-all (Express matches in registration order).
 *
 * Lock both invariants at the module-metadata level — far cheaper than a full
 * Nest bootstrap, and it fails CI instead of silently 404ing in production.
 */
function importsOf(module: any): any[] {
  return Reflect.getMetadata('imports', module) ?? []
}

describe('versions route registration', () => {
  const imports = importsOf(AppModule)

  it('AppModule registers VersionsModule (so /versions/* is mounted)', () => {
    expect(imports).toContain(VersionsModule)
  })

  it('VersionsModule is registered before the unified catch-all (so its routes win)', () => {
    const vIdx = imports.indexOf(VersionsModule)
    const uIdx = imports.indexOf(UnifiedEndpointModule)
    expect(vIdx).toBeGreaterThanOrEqual(0)
    expect(uIdx).toBeGreaterThanOrEqual(0)
    expect(vIdx).toBeLessThan(uIdx)
  })
})
