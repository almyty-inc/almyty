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

  it('goes last and grows to fill its row below sm', () => {
    renderToolbar()
    const classes = screen.getByTestId('agent-mode-toggle').className.split(/\s+/)
    expect(classes).toEqual(expect.arrayContaining(['order-last', 'flex-1', 'sm:flex-none']))
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
describe('the builder toolbar buttons on a phone', () => {
  // Below sm, Save and Test show their icon only (the word is `hidden`).
  // Without an aria-label they had no name at all on a phone.
  it('keeps Save and Test named when their word is hidden', () => {
    renderToolbar({ isEditing: true })
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toHaveAttribute('aria-label', 'Save')
    expect(within(save).getByText('Save').className).toMatch(/\bhidden\b/)
    expect(screen.getByRole('button', { name: 'Test' })).toHaveAttribute('aria-label', 'Test')
  })

  it('draws the mode toggle as a segmented control on the card surface', () => {
    renderToolbar({ agentMode: 'autonomous' })
    const on = within(screen.getByTestId('agent-mode-toggle')).getByRole('button', { name: 'Autonomous' })
    expect(on).toHaveAttribute('aria-pressed', 'true')
    expect(on.className).toContain('bg-card')
  })

  it('shows the name field as visibly editable with a focus ring', () => {
    renderToolbar()
    const name = screen.getByRole('textbox', { name: 'Agent name' })
    expect(name.className).not.toContain('focus-visible:ring-0')
    expect(name.className).toContain('hover:border-input')
  })
})
