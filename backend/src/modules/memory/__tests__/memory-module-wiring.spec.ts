import { MemoryModule } from '../memory.module'
import { CanonicalMemoryController } from '../canonical/canonical-memory.controller'

// Regression for #102: CanonicalMemoryController was imported but
// missing from the @Module's controllers array, so every /memory
// route 404'd in prod. This test reads the decorator metadata
// directly so a future refactor that re-introduces the gap fails
// loudly here instead of silently in staging.

describe('MemoryModule wiring', () => {
  it('registers CanonicalMemoryController on the module', () => {
    const controllers = Reflect.getMetadata('controllers', MemoryModule) ?? []
    expect(controllers).toContain(CanonicalMemoryController)
  })
})
