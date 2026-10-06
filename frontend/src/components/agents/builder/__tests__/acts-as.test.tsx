import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'

const entitlement = vi.hoisted(() => ({ enabled: false, isLoading: false }))
vi.mock('@/hooks/use-entitlement', () => ({ useEntitlement: () => entitlement }))

import { ActsAs } from '../capabilities-section'

const renderActsAs = (agentConfig: Record<string, any>, onChange = vi.fn()) =>
  render(
    <MemoryRouter>
      <ActsAs agentConfig={agentConfig} onChange={onChange} />
    </MemoryRouter>,
  )

describe('who the agent acts as', () => {
  beforeEach(() => {
    // Radix Select in jsdom.
    if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn()
    entitlement.enabled = false
    entitlement.isLoading = false
  })

  it('acts as its owner by default', () => {
    renderActsAs({})
    expect(screen.getByLabelText('Acts as')).toHaveTextContent('You, its owner')
    expect(screen.getByTestId('acts-as-hint')).toHaveTextContent('It uses what you can use')
  })

  it('is locked to the owner without the Business plan, and says where to get it', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderActsAs({}, onChange)
    expect(screen.getByTestId('acts-as-locked')).toHaveTextContent('part of the Business plan')
    expect(screen.getByRole('link', { name: 'See plans' })).toHaveAttribute('href', '/settings/billing')
    await user.click(screen.getByLabelText('Acts as'))
    expect(screen.getByRole('option', { name: 'Itself, with its own access' })).toHaveAttribute('aria-disabled', 'true')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('writes runAs when the plan includes it', async () => {
    entitlement.enabled = true
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderActsAs({}, onChange)
    expect(screen.queryByTestId('acts-as-locked')).not.toBeInTheDocument()
    await user.click(screen.getByLabelText('Acts as'))
    await user.click(screen.getByRole('option', { name: 'Itself, with its own access' }))
    expect(onChange).toHaveBeenLastCalledWith({ runAs: 'agent' })
  })

  it('says plainly what acting as itself means, and what a lapsed plan does to it', () => {
    renderActsAs({ runAs: 'agent' })
    expect(screen.getByTestId('acts-as-hint')).toHaveTextContent('only the connections given to it')
    expect(screen.getByTestId('acts-as-locked')).toHaveTextContent('its runs act as you until it does')
  })
})
