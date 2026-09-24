/**
 * The add-grant form sits inline under the grants list. A grant with an
 * expiry typed in but not added asks before a navigation throws it away.
 */
import { describe, it, vi, beforeEach } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'

import { renderAtRoute } from '@/test/render-at-route'
import { expectLeaveAsks, expectLeavesWithoutAsking } from '@/test/leave-guard'
import { GrantsEditor } from '../grants-editor'
import { connectionsApi } from '@/lib/connections-api'

vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))

vi.mock('@/lib/connections-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/connections-api')>('@/lib/connections-api')
  return { ...actual, connectionsApi: { listGrants: vi.fn(), addGrant: vi.fn(), removeGrant: vi.fn() } }
})
vi.mock('@/lib/api', () => ({
  organizationsApi: { getMembers: vi.fn().mockResolvedValue([]), getTeams: vi.fn().mockResolvedValue([]) },
  agentsApi: { getAll: vi.fn().mockResolvedValue([]) },
  workspacesApi: { getAll: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@/store/app', () => ({
  useNotifications: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}))
vi.mock('@/store/organization', () => ({
  useOrganizationStore: (selector?: (s: any) => any) => {
    const state = { currentOrganization: { id: 'org-1', name: 'Test Org' } }
    return selector ? selector(state) : state
  },
}))

beforeEach(() => {
  vi.mocked(connectionsApi.listGrants).mockResolvedValue([])
})

const at = () => renderAtRoute(<GrantsEditor connectionId="c1" />, { path: '/connections/c1', paths: ['/elsewhere'] })

describe('add grant', () => {
  it('asks while an expiry is set and the grant not added', async () => {
    const { router } = at()
    fireEvent.change(await screen.findByLabelText(/Expires/), { target: { value: '2027-01-01T09:00' } })
    await expectLeaveAsks(router)
  })

  it('leaves an untouched form without asking', async () => {
    const { router } = at()
    await screen.findByLabelText(/Expires/)
    await expectLeavesWithoutAsking(router)
  })
})
