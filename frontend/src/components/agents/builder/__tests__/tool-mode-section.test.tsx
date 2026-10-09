import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ToolModeSection, capabilityProblems, toolModeProblems } from '../capabilities-section'

const TOOLS = [
  { id: 't-1', name: 'crm_lookup' },
  { id: 't-2', name: 'issue_refund' },
]

describe('how the model sees its tools', () => {
  beforeEach(() => {
    // Radix Select in jsdom.
    if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn()
  })

  it('is automatic by default, with the threshold and pinning on the page', () => {
    render(<ToolModeSection agentConfig={{}} usableTools={TOOLS} onChange={vi.fn()} />)
    expect(screen.getByLabelText('Tool list')).toHaveTextContent('Automatic')
    expect(screen.getByLabelText('Switch to searching above (tokens)')).toHaveAttribute('placeholder', 'Default')
    expect(screen.getByLabelText('Always show Crm lookup')).toBeInTheDocument()
  })

  it('shows every tool: no threshold, nothing to pin', () => {
    render(<ToolModeSection agentConfig={{ toolMode: 'direct' }} usableTools={TOOLS} onChange={vi.fn()} />)
    expect(screen.queryByLabelText('Switch to searching above (tokens)')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Always show Crm lookup')).not.toBeInTheDocument()
  })

  it('writes the mode, the threshold and the pinned tools into agentConfig', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const { rerender } = render(<ToolModeSection agentConfig={{}} usableTools={TOOLS} onChange={onChange} />)

    await user.click(screen.getByLabelText('Tool list'))
    await user.click(screen.getByRole('option', { name: 'Search for tools' }))
    expect(onChange).toHaveBeenLastCalledWith({ toolMode: 'discover' })

    await user.type(screen.getByLabelText('Switch to searching above (tokens)'), '5')
    expect(onChange).toHaveBeenLastCalledWith({ toolModeThresholdTokens: 5 })

    await user.click(screen.getByLabelText('Always show Issue refund'))
    expect(onChange).toHaveBeenLastCalledWith({ pinnedToolIds: ['t-2'] })

    rerender(<ToolModeSection agentConfig={{ pinnedToolIds: ['t-2'] }} usableTools={TOOLS} onChange={onChange} />)
    expect(screen.getByTestId('pin-summary')).toHaveTextContent('Always shown: Issue refund')
    await user.click(screen.getByLabelText('Always show Issue refund'))
    expect(onChange).toHaveBeenLastCalledWith({ pinnedToolIds: undefined })
  })

  it('blocks a save with a threshold that is not a whole number of tokens', () => {
    expect(toolModeProblems({ toolModeThresholdTokens: 5000 })).toEqual([])
    expect(toolModeProblems({ toolModeThresholdTokens: 0 })).toHaveLength(1)
    expect(capabilityProblems({ toolModeThresholdTokens: 2.5 })).toHaveLength(1)
  })

  it('is part of Capabilities, offering only the tools this agent may use', () => {
    const source = readFileSync(join(__dirname, '..', 'capabilities-section.tsx'), 'utf8')
    expect(source).toMatch(/<ToolModeSection[\s\S]*usableTools=\{tools\.filter\(\(t\) => toolIds\.includes\(t\.id\) \|\| \(t\.apiId && \(agentConfig\.apiIds \?\? \[\]\)\.includes\(t\.apiId\)\)\)\}/)
  })

  it('offers scripts, and asks what a script may change: changes run, deletions wait for a person by default', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const { rerender } = render(<ToolModeSection agentConfig={{}} usableTools={TOOLS} onChange={onChange} />)
    await user.click(screen.getByLabelText('Tool list'))
    await user.click(screen.getByRole('option', { name: 'Search, and write scripts' }))
    expect(onChange).toHaveBeenLastCalledWith({ toolMode: 'code' })
    expect(screen.queryByTestId('script-changes')).not.toBeInTheDocument()

    rerender(<ToolModeSection agentConfig={{ toolMode: 'code' }} usableTools={TOOLS} onChange={onChange} />)
    expect(screen.getByLabelText('Changes to data')).toHaveTextContent('Make them')
    expect(screen.getByLabelText('Deletions')).toHaveTextContent('Ask a person first')
    await user.click(screen.getByLabelText('Changes to data'))
    await user.click(screen.getByRole('option', { name: 'Ask a person first' }))
    expect(onChange).toHaveBeenLastCalledWith({ codeMode: { writes: { write: 'stage' } } })
  })
})
