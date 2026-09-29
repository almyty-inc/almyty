import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The step side panels use the shared controls and name tools for people:
 * no native checkbox (it ignores the theme, bright white in dark mode), and
 * a tool reads "Place an order for a pet", not its machine name.
 */
const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8')

describe('workflow step panels', () => {
  const panel = read('node-config-panel.tsx')

  it('ticks tools with the shared Checkbox, not a native input', () => {
    expect(panel).toMatch(/import \{ Checkbox \} from '@\/components\/ui\/checkbox'/)
    expect(panel).not.toMatch(/<input\s+type="checkbox"/)
  })

  it('lists tools by readable name in the model and tool steps', () => {
    expect(panel).toMatch(/import \{ readableToolName \} from '@\/lib\/tool-names'/)
    expect(panel).not.toMatch(/>\s*\{(t|tool)\.name\}/)
  })

  it('shows the readable tool name on the canvas', () => {
    expect(read('nodes/tool-call-node.tsx')).toMatch(/data\.toolLabel/)
  })

  it('picks the agent of a sub-agent step with the shared AgentSelect', () => {
    expect(panel).toMatch(/<AgentSelect[\s\S]*?id="sub-agent-agent"/)
  })
})
