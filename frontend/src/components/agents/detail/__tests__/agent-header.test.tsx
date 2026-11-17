import { describe, it, expect, vi } from 'vitest'
import { screen, fireEvent, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders } from '../../../../test/setup'
import { AgentHeader } from '../agent-header'
import type { Agent } from '@/types'

const agent = {
  id: 'a1',
  name: 'Ops Copilot',
  description: 'Handles ops tickets',
  status: 'active',
} as Agent

const renderHeader = (overrides: Partial<React.ComponentProps<typeof AgentHeader>> = {}) => {
  const handlers = {
    onExport: vi.fn(),
    onExportTechDoc: vi.fn(),
    onDuplicate: vi.fn(),
    onInvoke: vi.fn(),
    onActivate: vi.fn(),
    onDeactivate: vi.fn(),
  }
  renderWithProviders(<AgentHeader agent={agent} {...handlers} {...overrides} />)
  return handlers
}

describe('AgentHeader', () => {
  it('lets the title and action buttons wrap instead of overflowing narrow screens', () => {
    renderHeader({ agent: { ...agent, name: 'QA Strategy Runtime 20260915' } as Agent })
    const actions = screen.getByRole('group', { name: 'Agent actions' })
    expect(actions).toHaveClass('flex-wrap', 'max-w-full')
    expect(actions.parentElement).toHaveClass('flex-wrap')
    expect(screen.getByRole('heading', { level: 1 })).toHaveClass('[overflow-wrap:anywhere]')
  })

  it('blocks activation when model setup is not ready without changing the existing Run action', () => {
    const handlers = renderHeader({ agent: { ...agent, status: 'inactive' } as Agent, activationDisabled: true })
    const activate = screen.getByRole('button', { name: /^activate$/i })
    expect(activate).toBeDisabled()
    fireEvent.click(activate)
    expect(handlers.onActivate).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /^run$/i })).toBeEnabled()
  })

  it('renders the technical documentation export action next to Export', () => {
    renderHeader()

    expect(screen.getByRole('button', { name: /export/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /tech doc/i })).toBeInTheDocument()
  })

  it('fires onExportTechDoc when the tech doc button is clicked, without touching other handlers', () => {
    const handlers = renderHeader()

    fireEvent.click(screen.getByRole('button', { name: /tech doc/i }))

    expect(handlers.onExportTechDoc).toHaveBeenCalledTimes(1)
    expect(handlers.onExport).not.toHaveBeenCalled()
    expect(handlers.onDuplicate).not.toHaveBeenCalled()
    expect(handlers.onInvoke).not.toHaveBeenCalled()
  })

  it('still fires the existing JSON export handler independently', () => {
    const handlers = renderHeader()

    fireEvent.click(screen.getByRole('button', { name: /^export$/i }))

    expect(handlers.onExport).toHaveBeenCalledTimes(1)
    expect(handlers.onExportTechDoc).not.toHaveBeenCalled()
  })

  it('offers Activate when the agent is not active, and fires onActivate', () => {
    const handlers = renderHeader({ agent: { ...agent, status: 'draft' } as Agent })

    fireEvent.click(screen.getByRole('button', { name: /^activate$/i }))

    expect(handlers.onActivate).toHaveBeenCalledTimes(1)
    expect(handlers.onDeactivate).not.toHaveBeenCalled()
  })

  describe('on a phone', () => {
    it('keeps Run and Edit as buttons and hides the other actions below sm', () => {
      renderHeader()
      const run = screen.getByRole('button', { name: /^run$/i })
      const edit = screen.getByRole('button', { name: /^edit$/i })
      const desktopOnly = screen.getByRole('button', { name: /^duplicate$/i }).parentElement!
      expect(desktopOnly).toHaveClass('hidden', 'sm:flex')
      for (const name of [/^export$/i, /tech doc/i, /^deactivate$/i]) {
        expect(desktopOnly).toContainElement(screen.getByRole('button', { name }))
      }
      expect(desktopOnly).not.toContainElement(run)
      expect(desktopOnly).not.toContainElement(edit)
      expect(screen.getByTestId('agent-actions-overflow')).toHaveClass('sm:hidden')
    })

    it('offers the other actions in an overflow menu', async () => {
      const user = userEvent.setup()
      const handlers = renderHeader()
      await user.click(screen.getByRole('button', { name: 'More agent actions' }))
      const menu = await screen.findByRole('menu')
      expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Export', 'Tech doc', 'Duplicate', 'Deactivate'])
      await user.click(within(menu).getByRole('menuitem', { name: 'Duplicate' }))
      expect(handlers.onDuplicate).toHaveBeenCalledTimes(1)
      expect(handlers.onExport).not.toHaveBeenCalled()
    })

    it('offers Activate in the menu, disabled while setup is not ready', async () => {
      const user = userEvent.setup()
      renderHeader({ agent: { ...agent, status: 'draft' } as Agent, activationDisabled: true })
      await user.click(screen.getByRole('button', { name: 'More agent actions' }))
      expect(await screen.findByRole('menuitem', { name: 'Activate' })).toHaveAttribute('data-disabled')
    })
  })
})
