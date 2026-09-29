/**
 * Access keys live on the agent they unlock: this agent's keys, a new one
 * shown once, revoke behind a one-line confirm, and only for admins (the
 * keys API is admin-only).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'

import { render } from '../../../test/setup'
import { AgentAccessKeysSection, keysForAgent } from '../access-keys-section'
import { accessKeysApi } from '../../../lib/api'

vi.mock('../../../lib/api', () => ({
  accessKeysApi: { getAll: vi.fn(), create: vi.fn(), revoke: vi.fn() },
}))

const role = { role: 'admin' as string | null, canManage: true, isOwner: false }
vi.mock('../../../hooks/use-organization-role', () => ({ useOrganizationRole: () => role }))

const KEYS = [
  { id: 'k1', name: 'Production', keyPrefix: 'alm_ab12', scopes: ['read'], agent: { id: 'agent-1', name: 'Support bot' }, gateway: null, createdAt: '2026-09-01T00:00:00Z', lastUsedAt: null },
  { id: 'k2', name: 'Other agent key', keyPrefix: 'alm_cd34', scopes: ['read'], agent: { id: 'agent-2', name: 'Other' }, gateway: null, createdAt: '2026-09-01T00:00:00Z', lastUsedAt: null },
  { id: 'k3', name: 'Gateway key', keyPrefix: 'alm_ef56', scopes: ['read'], agent: null, gateway: { id: 'gw-1', name: 'GW' }, createdAt: '2026-09-01T00:00:00Z', lastUsedAt: null },
]

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(role, { role: 'admin', canManage: true })
  vi.mocked(accessKeysApi.getAll).mockResolvedValue(KEYS)
})

describe('AgentAccessKeysSection', () => {
  it("lists this agent's keys and nobody else's", async () => {
    render(<AgentAccessKeysSection agentId="agent-1" agentName="Support bot" />)
    const list = await screen.findByRole('list', { name: 'Access keys' })
    expect(within(list).getByText('Production')).toBeInTheDocument()
    expect(within(list).queryByText('Other agent key')).not.toBeInTheDocument()
    expect(within(list).queryByText('Gateway key')).not.toBeInTheDocument()
  })

  it('makes a key for this agent and shows it once', async () => {
    vi.mocked(accessKeysApi.create).mockResolvedValue({ id: 'k9', name: 'CI', keyPrefix: 'alm_zz', plainTextKey: 'alm_zz_full_secret' })
    render(<AgentAccessKeysSection agentId="agent-1" agentName="Support bot" />)
    fireEvent.click(await screen.findByRole('button', { name: 'New key' }))
    const form = screen.getByRole('form', { name: 'New access key' })
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'CI' } })
    // Scopes wait under Advanced.
    expect(within(form).queryByRole('group', { name: 'What the key may do' })).not.toBeInTheDocument()
    fireEvent.click(within(form).getByRole('button', { name: 'Make key' }))

    await waitFor(() => expect(accessKeysApi.create).toHaveBeenCalledWith({ name: 'CI', scopes: ['read'], agentId: 'agent-1' }))
    const shown = await screen.findByTestId('generated-access-key')
    expect(within(shown).getByText('alm_zz_full_secret')).toHaveAttribute('data-sensitive-text')
    fireEvent.click(within(shown).getByRole('button', { name: "I've saved it" }))
    expect(screen.queryByText('alm_zz_full_secret')).not.toBeInTheDocument()
  })

  it('revokes after a one-line confirm', async () => {
    vi.mocked(accessKeysApi.revoke).mockResolvedValue(null)
    render(<AgentAccessKeysSection agentId="agent-1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }))
    const confirm = await screen.findByRole('alertdialog')
    fireEvent.click(within(confirm).getByRole('button', { name: 'Revoke key' }))
    await waitFor(() => expect(accessKeysApi.revoke).toHaveBeenCalledWith('k1'))
  })

  it('is not there for a member, who could not use the keys API anyway', () => {
    Object.assign(role, { role: 'member', canManage: false })
    render(<AgentAccessKeysSection agentId="agent-1" />)
    expect(screen.queryByTestId('agent-access-keys')).not.toBeInTheDocument()
    expect(accessKeysApi.getAll).not.toHaveBeenCalled()
  })

  it('reads the list whichever shape it comes in', () => {
    expect(keysForAgent({ keys: KEYS }, 'agent-2').map((k) => k.id)).toEqual(['k2'])
    expect(keysForAgent([{ id: 'x', agentId: 'agent-3' }], 'agent-3').map((k) => k.id)).toEqual(['x'])
    expect(keysForAgent(null, 'agent-1')).toEqual([])
  })
})
