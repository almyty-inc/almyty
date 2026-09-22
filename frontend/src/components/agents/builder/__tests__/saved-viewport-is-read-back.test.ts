import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Two rules the builder got wrong in opposite directions.
 *
 * The viewport: buildPipeline has always persisted { x, y, zoom } on every
 * save, and nothing ever read it back -- the init effect ignored it and both
 * canvases called fitView. So a graph you had positioned deliberately was
 * refitted every time you opened it, and the saved value was write-only
 * state. React Flow ignores defaultViewport whenever fitView is set, which
 * is why the two have to be mutually exclusive rather than both passed.
 *
 * The Model Call rule: the builder refused to save an llm_call node naming
 * no provider, policy or role. The server has no llm_call rule at all, and
 * the engine falls back to the organization's settings.defaultRouting -- so
 * for any org with a default, the builder was refusing a graph the API
 * accepts and the engine runs.
 */
// __dirname is src/components/agents/builder/__tests__, so src is four up.
const read = (rel: string) => readFileSync(join(__dirname, '..', '..', '..', '..', rel), 'utf8')
const canvas = read('components/agents/builder/canvas-area.tsx')
const builder = read('pages/agent-builder.tsx')

describe('the saved viewport is read back', () => {
  it('the canvas accepts one', () => {
    expect(canvas).toContain('savedViewport?: { x: number; y: number; zoom: number }')
  })

  it('uses defaultViewport instead of fitView when there is one', () => {
    expect(canvas).toContain('? { defaultViewport: savedViewport }')
    expect(canvas).toContain(': { fitView: true, fitViewOptions: { padding: 0.2 } })')
  })

  it('never passes both, since React Flow would ignore defaultViewport', () => {
    // A bare `fitView` prop alongside the spread would silently win.
    expect(canvas).not.toMatch(/^\s+fitView$/m)
  })

  it('the builder hands it the value it saved', () => {
    expect(builder).toContain('savedViewport={agentData?.pipeline?.viewport}')
  })
})
