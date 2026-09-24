/**
 * The run panel replaced the "Run agent" dialog. It is inline, it closes,
 * and the agent page actually opens it from the header's Run button -- a
 * panel nothing mounts would still compile and pass its own tests.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { fireEvent, screen } from '@testing-library/react'

import { render } from '../../../../test/setup'
import { RunPanel } from '../run-panel'

vi.mock('@/lib/api', () => ({ agentsApi: { invoke: vi.fn() } }))
vi.mock('@/store/app', () => ({
  useNotifications: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}))

describe('run panel', () => {
  const agent = { id: 'a1', name: 'Support bot' } as any

  it('renders inline, not as a dialog, and closes', () => {
    const onClose = vi.fn()
    render(<RunPanel agent={agent} onClose={onClose} />)

    const panel = screen.getByTestId('run-panel')
    expect(panel.tagName).toBe('SECTION')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Run agent' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run agent' })).toHaveAttribute('type', 'submit')

    fireEvent.click(screen.getByRole('button', { name: 'Close run panel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('is opened by the header Run button on the agent page', () => {
    const page = readFileSync(join(__dirname, '../../../../pages/agent-detail.tsx'), 'utf8')
    expect(page).toMatch(/import \{ RunPanel \} from '@\/components\/agents\/detail\/run-panel'/)
    expect(page).toMatch(/onInvoke=\{\(\) => setRunPanelOpen\(true\)\}/)
    expect(page).toMatch(/\{runPanelOpen && <RunPanel agent=\{agent\} onClose=\{\(\) => setRunPanelOpen\(false\)\} \/>\}/)
    expect(page).not.toMatch(/InvokeDialog/)
  })
})