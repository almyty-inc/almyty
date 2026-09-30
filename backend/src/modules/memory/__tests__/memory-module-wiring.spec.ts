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

describe('MemoryModule wiring: moving memories between accounts', () => {
  it('provides the move service and the processor that runs a move', () => {
    const { MemoryMoveService } = require('../canonical/memory-move.service')
    const { MemoryMoveProcessor } = require('../canonical/memory-move.processor')
    const providers = Reflect.getMetadata('providers', MemoryModule) ?? []
    expect(providers).toEqual(expect.arrayContaining([MemoryMoveService, MemoryMoveProcessor]))
  })

  it('registers the move queue the service enqueues on and the processor listens to', () => {
    const { MOVE_QUEUE_NAME } = require('../canonical/memory-move.service')
    const source = require('fs').readFileSync(require('path').join(__dirname, '..', 'memory.module.ts'), 'utf8')
    expect(source).toMatch(/\{ name: MOVE_QUEUE_NAME \}/)
    expect(MOVE_QUEUE_NAME).toBe('canonical-memory-move')
  })
})
