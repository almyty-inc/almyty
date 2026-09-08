import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'

import { render } from '../../../test/setup'
import { GrantsEditor, toPrincipalOptions, formatExpiry } from '../grants-editor'
import { connectionsApi } from '../../../lib/connections-api'
import { agentsApi, organizationsApi, workspacesApi } from '../../../lib/api'
import type { ConnectionGrant } from '@/types/connections'

vi.mock('../../../lib/connections-api', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/connections-api')>('../../../lib/connections-api')
  return {
    ...actual,
    connectionsApi: {
      listGrants: vi.fn(),
      addGrant: vi.fn(),
      removeGrant: vi.fn(),
    },
  }
})

vi.mock('../../../lib/api', () => ({
  organizationsApi: { getMembers: vi.fn(), getTeams: vi.fn() },
  agentsApi: { getAll: vi.fn() },
  workspacesApi: { getAll: vi.fn() },
}))

const notify = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
vi.mock('../../../store/app', () => ({
  useNotifications: () => notify,
}))

vi.mock('../../../store/organization', () => ({
  useOrganizationStore: (selector?: (s: any) => any) => {
    const state = { currentOrganization: { id: 'test-org-id', name: 'Test Org' } }
    return selector ? selector(state) : state
  },
}))

function grant(overrides: Partial<ConnectionGrant> = {}): ConnectionGrant {
  return {
    id: 'g1',
    principalType: 'team',
    principalId: 't1',
    principalName: 'Platform team',
    permission: 'use',
    grantedBy: 'u1',
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('toPrincipalOptions', () => {
  it('maps members, teams, agents and workspaces from bare arrays or keyed payloads', () => {
    expect(toPrincipalOptions('user', [{ userId: 'u1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' }])).toEqual([{ id: 'u1', label: 'Ada Lovelace (ada@example.com)' }])
    expect(toPrincipalOptions('user', { members: [{ id: 'u2', user: { email: 'x@example.com' } }] })).toEqual([{ id: 'u2', label: 'x@example.com' }])
    expect(toPrincipalOptions('team', [{ id: 't1', name: 'Platform' }])).toEqual([{ id: 't1', label: 'Platform' }])
    expect(toPrincipalOptions('agent', { agents: [{ id: 'a1', name: 'Support bot' }] })).toEqual([{ id: 'a1', label: 'Support bot' }])
    expect(toPrincipalOptions('workspace', [{ id: 'w1', name: 'Nightly' }])).toEqual([{ id: 'w1', label: 'Nightly' }])
    expect(toPrincipalOptions('role', undefined).map((r) => r.id)).toEqual(['owner', 'admin', 'member'])
  })

  it('formats a missing expiry as never', () => {
    expect(formatExpiry(undefined)).toBe('Never')
    expect(formatExpiry(null)).toBe('Never')
  })
})

describe('GrantsEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(organizationsApi.getMembers).mockResolvedValue([{ userId: 'u1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' }])
    vi.mocked(organizationsApi.getTeams).mockResolvedValue([{ id: 't1', name: 'Platform team' }])
    vi.mocked(agentsApi.getAll).mockResolvedValue([])
    vi.mocked(workspacesApi.getAll).mockResolvedValue([])
  })

  it('lists existing grants with their principal, permission and expiry', async () => {
    vi.mocked(connectionsApi.listGrants).mockResolvedValue([grant(), grant({ id: 'g2', principalType: 'role', principalId: 'admin', principalName: undefined, permission: 'manage' })])
    render(<GrantsEditor connectionId="conn-1" />)

    const list = await screen.findByTestId('grants-list')
    expect(list).toHaveTextContent('Platform team')
    expect(list).toHaveTextContent('admin')
    expect(list).toHaveTextContent('manage')
    expect(list).toHaveTextContent('Expires Never')
  })

  it('adds a team grant with the chosen permission', async () => {
    vi.mocked(connectionsApi.listGrants).mockResolvedValue([])
    vi.mocked(connectionsApi.addGrant).mockResolvedValue(grant())
    render(<GrantsEditor connectionId="conn-1" />)

    await screen.findByText(/No grants yet/)
    fireEvent.change(screen.getByLabelText('Principal type'), { target: { value: 'team' } })
    await waitFor(() => expect(organizationsApi.getTeams).toHaveBeenCalledWith('test-org-id'))
    await waitFor(() => expect(screen.getByRole('option', { name: 'Platform team' })).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Team'), { target: { value: 't1' } })
    fireEvent.change(screen.getByLabelText('Permission'), { target: { value: 'manage' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add grant' }))

    await waitFor(() => expect(connectionsApi.addGrant).toHaveBeenCalledWith('conn-1', { principalType: 'team', principalId: 't1', permission: 'manage' }))
    await waitFor(() => expect(notify.success).toHaveBeenCalledWith('Access granted', expect.any(String)))
  })

  it('refuses to add without a principal', async () => {
    vi.mocked(connectionsApi.listGrants).mockResolvedValue([])
    render(<GrantsEditor connectionId="conn-1" />)
    await screen.findByText(/No grants yet/)
    fireEvent.click(screen.getByRole('button', { name: 'Add grant' }))
    expect(await screen.findByText('Pick who gets access')).toBeInTheDocument()
    expect(connectionsApi.addGrant).not.toHaveBeenCalled()
  })

  it('revokes after confirming', async () => {
    vi.mocked(connectionsApi.listGrants).mockResolvedValue([grant()])
    vi.mocked(connectionsApi.removeGrant).mockResolvedValue(undefined)
    render(<GrantsEditor connectionId="conn-1" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Revoke Platform team' }))
    expect(await screen.findByText('Revoke access?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))

    await waitFor(() => expect(connectionsApi.removeGrant).toHaveBeenCalledWith('conn-1', 'g1'))
    await waitFor(() => expect(notify.success).toHaveBeenCalledWith('Access revoked', expect.any(String)))
  })

  it('hides the form and revoke buttons for use-only viewers', async () => {
    vi.mocked(connectionsApi.listGrants).mockResolvedValue([grant()])
    render(<GrantsEditor connectionId="conn-1" canManage={false} />)
    await screen.findByTestId('grants-list')
    expect(screen.queryByTestId('grant-form')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Revoke/ })).not.toBeInTheDocument()
  })
})
