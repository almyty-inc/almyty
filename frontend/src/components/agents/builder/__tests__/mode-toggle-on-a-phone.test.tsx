import { describe, it, expect, vi } from 'vitest'
import { screen, fireEvent, within } from '@testing-library/react'

import { render } from '../../../../test/setup'
import { BuilderToolbar, type BuilderToolbarProps } from '../builder-toolbar'

/**
 * The Workflow/Autonomous toggle is the only way to make an autonomous
 * agent. It was `hidden sm:flex`, so on a phone (390px) there was no way
 * to make one at all. jsdom applies no CSS, so these read the classes:
 * no breakpoint may hide the toggle, and below sm it takes its own row.
 */
function renderToolbar(overrides: Partial<BuilderToolbarProps> = {}) {
  const props: BuilderToolbarProps = {
    agentName: 'Agent',
    onAgentNameChange: vi.fn(),
    agentStatus: 'draft',
    agentMode: 'workflow',
    onAgentModeChange: vi.fn(),
    canUndo: false,
    canRedo: false,
    undo: vi.fn(),
    redo: vi.fn(),
    isEditing: false,
    showTestPanel: false,
    onToggleTestPanel: vi.fn(),
    saveDisabled: false,
    isSaving: false,
    onSave: vi.fn(),
    onExport: vi.fn(),
    onBack: vi.fn(),
    ...overrides,
  }
  render(<BuilderToolbar {...props} />)
  return props
}

describe('the builder mode toggle on a phone', () => {
  it('is never hidden at any breakpoint', () => {
    renderToolbar()
    const toggle = screen.getByTestId('agent-mode-toggle')
    const classes = toggle.className.split(/\s+/)
    expect(classes.filter((c) => /(^|:)hidden$/.test(c))).toEqual([])
    // Nothing above it hides it either.
    for (let el = toggle.parentElement; el; el = el.parentElement) {
      expect(el.className.split(/\s+/).filter((c) => /(^|:)hidden$/.test(c))).toEqual([])
    }
  })

  it('takes a full-width row of its own below sm', () => {
    renderToolbar()
    const classes = screen.getByTestId('agent-mode-toggle').className.split(/\s+/)
    expect(classes).toEqual(expect.arrayContaining(['w-full', 'order-last', 'sm:w-auto']))
    expect(screen.getByTestId('agent-mode-toggle').parentElement!.className).toMatch(/\bflex-wrap\b/)
  })

  it('switches to autonomous and says which mode is on', () => {
    const props = renderToolbar()
    const toggle = screen.getByTestId('agent-mode-toggle')
    const autonomous = within(toggle).getByRole('button', { name: 'Autonomous' })
    expect(autonomous).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(autonomous)
    expect(props.onAgentModeChange).toHaveBeenCalledWith('autonomous')
  })
})