/**
 * "Add memory" is an inline form at the top of the Memory card, not a
 * dialog: the list stays in view, Cancel puts the card back, and the
 * form refuses to save an empty memory with a field error.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { renderWithProviders } from '@/test/setup'
import { MemoryTab } from '../memory-tab'
import { memoriesApi } from '@/lib/api'
import type { Memory } from '@/types'

vi.mock('@/lib/api', () => ({ memoriesApi: { put: vi.fn() } }))
const notify = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('@/store/app', () => ({ useNotifications: () => notify }))
vi.mock('@/store/organization', () => ({
  useOrganizationStore: (selector?: (s: any) => unknown) => {
    const state = { currentOrganization: { id: 'org-1' } }
    return selector ? selector(state) : state
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
  if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = vi.fn()
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = vi.fn()
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn()
})

const memory = {
  id: 'm1', content: 'Customer prefers email', type: 'preference', scope: 'workspace',
  tags: ['crm'], accessCount: 2,
} as unknown as Memory

describe('MemoryTab add memory', () => {
  it('opens an inline form, not a dialog, and keeps the list in view', async () => {
    const user = userEvent.setup()
    renderWithProviders(<MemoryTab agentId="agent-1" memories={[memory]} />)

    await user.click(screen.getByRole('button', { name: /Add memory/ }))
    const form = screen.getByTestId('add-memory-form')
    expect(form.tagName).toBe('FORM')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText('Customer prefers email')).toBeInTheDocument()
    // One way to open it at a time.
    expect(screen.getAllByRole('button', { name: /Add memory/ })).toHaveLength(1)
    expect(within(form).getByRole('button', { name: 'Add memory' })).toHaveAttribute('type', 'submit')
  })

  it('refuses an empty memory with a field error and no request', async () => {
    const user = userEvent.setup()
    renderWithProviders(<MemoryTab agentId="agent-1" memories={[]} />)

    // The header and the empty state offer the same action; use the empty state's.
    const openers = screen.getAllByRole('button', { name: /Add memory/ })
    expect(openers).toHaveLength(2)
    await user.click(openers[1])
    // The empty state gives way to the form.
    expect(screen.queryByText('No memories yet')).not.toBeInTheDocument()
    await user.click(within(screen.getByTestId('add-memory-form')).getByRole('button', { name: 'Add memory' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Write what the agent should remember.')
    expect(screen.getByLabelText(/Content/)).toHaveAttribute('aria-invalid', 'true')
    expect(memoriesApi.put).not.toHaveBeenCalled()
  })

  it('saves the memory with its tier and tags, then closes the form', async () => {
    const user = userEvent.setup()
    ;(memoriesApi.put as any).mockResolvedValue({ id: 'm2' })
    renderWithProviders(<MemoryTab agentId="agent-1" memories={[memory]} />)

    await user.click(screen.getByRole('button', { name: /Add memory/ }))
    await user.type(screen.getByLabelText(/Content/), 'Escalate refunds over 500 EUR')
    await user.click(screen.getByRole('combobox'))
    await user.click(await screen.findByRole('option', { name: 'Context' }))
    await user.type(screen.getByLabelText('Tags'), 'billing, refunds')
    await user.click(within(screen.getByTestId('add-memory-form')).getByRole('button', { name: 'Add memory' }))

    await waitFor(() => expect(memoriesApi.put).toHaveBeenCalledTimes(1))
    expect((memoriesApi.put as any).mock.calls[0][0]).toMatchObject({
      content: 'Escalate refunds over 500 EUR',
      tier: 'short',
      tags: ['billing', 'refunds'],
      scope: { scope_type: 'workspace', scope_id: 'org-1' },
      provenance: expect.objectContaining({ agent_id: 'agent-1' }),
    })
    await waitFor(() => expect(screen.queryByTestId('add-memory-form')).not.toBeInTheDocument())
    expect(notify.success).toHaveBeenCalled()
  })

  it('Cancel closes the form and drops what was typed', async () => {
    const user = userEvent.setup()
    renderWithProviders(<MemoryTab agentId="agent-1" memories={[memory]} />)

    await user.click(screen.getByRole('button', { name: /Add memory/ }))
    await user.type(screen.getByLabelText(/Content/), 'draft')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('add-memory-form')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Add memory/ }))
    expect(screen.getByLabelText(/Content/)).toHaveValue('')
    expect(memoriesApi.put).not.toHaveBeenCalled()
  })
})