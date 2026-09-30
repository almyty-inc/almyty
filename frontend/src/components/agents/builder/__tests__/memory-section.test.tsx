/**
 * Adding a memory account without leaving the agent: pick the service,
 * connect an account with the shared connect flow, and it becomes this
 * agent's own account for that service. Anyone who can edit the agent may
 * do it: the organization's memory settings are not touched, and the
 * connection's own scope decides who can use it (the server checks it
 * against the agent's).
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
  credentialsApi: {
    getAll: vi.fn().mockResolvedValue([{ id: 'cred-7', name: 'Support Zep', type: 'memory_backend' }]),
  },
}))
vi.mock('@/components/credentials/credential-picker', () => ({
  CredentialPicker: ({ onChange }: { onChange: (c: any) => void }) => (
    <button type="button" onClick={() => onChange({ id: 'cred-9', name: 'Team Mem0' })}>
      Create one here
    </button>
  ),
}))

describe("an agent's own memory account", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(memoriesApi.listAccounts).mockResolvedValue([{ id: 'almyty-native', name: "almyty's own memory", canExpire: true, expiresItself: true }] as any)
    vi.mocked(memoriesApi.listBackends).mockResolvedValue([
      { id: 'almyty-native', modes: ['memory', 'document'], canExpire: true },
      { id: 'mem0', modes: ['memory'], canExpire: true },
      { id: 'zep', modes: ['memory'], canExpire: true },
      { id: 'vertex-memory-bank', modes: ['memory'], canExpire: false },
    ] as any)
    if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
    if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = vi.fn()
    if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = vi.fn()
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn()
  })

  it("connects one and chooses it for this agent, without touching the organization's settings", async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderWithProviders(<MemorySection value={{ enabled: true }} onChange={onChange} />)

    await user.click(await screen.findByRole('button', { name: 'Add a memory account' }))
    const add = screen.getByTestId('add-memory-account')
    await user.click(within(add).getByRole('combobox', { name: 'Memory service' }))
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Mem0', 'Zep', 'Vertex AI Memory Bank'])
    await user.click(screen.getByRole('option', { name: 'Mem0' }))
    await user.click(within(add).getByRole('button', { name: 'Create one here' }))

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ account: 'mem0', credentialId: 'cred-9' })))
    expect(memoriesApi.updateConfig).not.toHaveBeenCalled()
  })

  it('shows it by its service and connection name, and going back to an organization account drops it', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderWithProviders(<MemorySection value={{ enabled: true, account: 'zep', credentialId: 'cred-7' }} onChange={onChange} />)
    const account = await screen.findByRole('combobox', { name: 'Memory account' })
    await waitFor(() => expect(account).toHaveTextContent('Zep: Support Zep'))
    await user.click(account)
    await user.click(await screen.findByRole('option', { name: "almyty's own memory" }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ account: 'almyty-native', credentialId: null }))
  })
})
