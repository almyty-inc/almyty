import { describe, it, expect, vi } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'

import { render } from '../../../../test/setup'
import { BuilderToolbar, DEFAULT_AGENT_NAME, type BuilderToolbarProps } from '../builder-toolbar'

/**
 * A new agent starts named "New agent". Clicking in and typing a name
 * used to add to it: "Morning weather briefNew agent" was saved and shown
 * as the agent's title. The starting name is selected on focus, so typing
 * replaces it; a name someone chose is left alone.
 */
function renderToolbar(agentName: string) {
  const props: BuilderToolbarProps = {
    agentName,
    onAgentNameChange: vi.fn(),
    agentStatus: 'draft',
    agentMode: 'autonomous',
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
  }
  render(<BuilderToolbar {...props} />)
  return screen.getByRole('textbox', { name: 'Agent name' }) as HTMLInputElement
}

describe('the agent name field', () => {
  it('selects the starting name on focus, so typing replaces it', () => {
    const input = renderToolbar(DEFAULT_AGENT_NAME)
    fireEvent.focus(input)
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(DEFAULT_AGENT_NAME.length)
  })

  it('leaves a chosen name unselected', () => {
    const input = renderToolbar('Morning weather brief')
    input.setSelectionRange(3, 3)
    fireEvent.focus(input)
    expect(input.selectionEnd - input.selectionStart).toBe(0)
  })
})
