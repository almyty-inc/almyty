import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { render } from '../../../../test/setup'
import { BuilderToolbar, AGENT_NAME_PLACEHOLDER, type BuilderToolbarProps } from '../builder-toolbar'

/**
 * A new agent used to start with the value "New agent". Typing a name as
 * the page opened put the caret before it, and "Morning weather briefNew
 * agent" was saved as the agent's title. The name now starts empty and the
 * hint is a placeholder, which is never part of what is typed.
 */
function NameField({ onChange }: { onChange: (v: string) => void }) {
  const props: BuilderToolbarProps = {
    agentName: '',
    onAgentNameChange: onChange,
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
  return <BuilderToolbar {...props} />
}

describe('the agent name field of a new agent', () => {
  it('starts empty, with the hint as a placeholder', () => {
    render(<NameField onChange={vi.fn()} />)
    const input = screen.getByRole('textbox', { name: 'Agent name' }) as HTMLInputElement
    expect(input.value).toBe('')
    expect(input.placeholder).toBe(AGENT_NAME_PLACEHOLDER)
  })

  it('takes exactly what is typed', async () => {
    const onChange = vi.fn()
    render(<NameField onChange={onChange} />)
    await userEvent.type(screen.getByRole('textbox', { name: 'Agent name' }), 'W')
    expect(onChange).toHaveBeenLastCalledWith('W')
  })
})
