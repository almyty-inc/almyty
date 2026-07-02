import { describe, it, expect, vi } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'
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
  }
  renderWithProviders(<AgentHeader agent={agent} {...handlers} {...overrides} />)
  return handlers
}

describe('AgentHeader', () => {
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
})
