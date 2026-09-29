/**
 * Adding a memory account without leaving the agent: pick the service,
 * connect an account with the shared connect flow, and it is set up for
 * the organization (its memory settings name the new credential for that
 * service) and chosen for this agent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { renderWithProviders } from '@/test/setup'
import { MemorySection } from '../memory-section'
import { memoriesApi } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  memoriesApi: {
    listAccounts: vi.fn(),
    listBackends: vi.fn(),
    getConfig: vi.fn(),
    updateConfig: vi.fn(),
  },
}))
vi.mock('@/components/connections/connect-flow', () => ({
  ConnectAccountButton: ({ onConnected }: { onConnected: (c: any) => void }) => (
    <button type="button" onClick={() => onConnected({ id: 'cred-9', name: 'Team Mem0' })}>
      Connect an account
    </button>
  ),
}))
vi.mock('@/store/organization', () => ({
  useOrganizationStore: (selector?: (s: any) => unknown) => {
    const state = { currentOrganization: { id: 'org-1' } }
    return selector ? selector(state) : state
  },
}))
const notifyError = vi.fn()
vi.mock('@/store/app', () => ({ useNotifications: () => ({ success: vi.fn(), error: notifyError }) }))

describe('adding a memory account from the agent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(memoriesApi.listAccounts).mockResolvedValue([{ id: 'almyty-native', name: "almyty's own memory", canExpire: true, expiresItself: true }] as any)
    vi.mocked(memoriesApi.listBackends).mockResolvedValue([
      { id: 'almyty-native', modes: ['memory', 'document'] },
      { id: 'mem0', modes: ['memory'] },
      { id: 'supermemory', modes: ['memory', 'document'] },
    ] as any)
    vi.mocked(memoriesApi.getConfig).mockResolvedValue({ overrides: { softcap: 1, routing: { memory_backend: 'almyty-native', credentials: { zep: 'cred-1' } } } } as any)
    vi.mocked(memoriesApi.updateConfig).mockResolvedValue({} as any)
    if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
    if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = vi.fn()
    if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = vi.fn()
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn()
  })

  it('connects it, sets it up for the organization, and chooses it', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderWithProviders(<MemorySection value={{ enabled: true }} onChange={onChange} />)

    await user.click(await screen.findByRole('button', { name: 'Add a memory account' }))
    const add = screen.getByTestId('add-memory-account')
    await user.click(within(add).getByRole('combobox', { name: 'Memory service' }))
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Mem0', 'Supermemory'])
    await user.click(screen.getByRole('option', { name: 'Mem0' }))
    await user.click(within(add).getByRole('button', { name: 'Connect an account' }))

    await waitFor(() => expect(memoriesApi.updateConfig).toHaveBeenCalled())
    expect(memoriesApi.updateConfig).toHaveBeenCalledWith({
      scope_type: 'workspace',
      scope_id: 'org-1',
      overrides: { softcap: 1, routing: { memory_backend: 'almyty-native', credentials: { zep: 'cred-1', mem0: 'cred-9' } } },
    })
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ account: 'mem0' })))
  })

  it('says why when the organization settings cannot be changed', async () => {
    const user = userEvent.setup()
    vi.mocked(memoriesApi.updateConfig).mockRejectedValue({ response: { status: 403, data: { message: 'Forbidden resource' } } })
    renderWithProviders(<MemorySection value={{ enabled: true }} onChange={vi.fn()} />)
    await user.click(await screen.findByRole('button', { name: 'Add a memory account' }))
    await user.click(within(screen.getByTestId('add-memory-account')).getByRole('combobox', { name: 'Memory service' }))
    await user.click(await screen.findByRole('option', { name: 'Mem0' }))
    await user.click(screen.getByRole('button', { name: 'Connect an account' }))
    await waitFor(() => expect(notifyError).toHaveBeenCalledWith('Could not set up the account', expect.any(String)))
  })
})
