/**
 * Inline forms on the approvals, organization and provider pages ask
 * before a navigation throws away what was typed into them. A clean form,
 * a cancelled one and a save that lands all leave without asking.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'

import { renderAtRoute } from '@/test/render-at-route'
import { expectLeaveAsks, expectLeavesWithoutAsking } from '@/test/leave-guard'
import { ApprovalsPage } from '../approvals'
import { OrganizationDetailPage } from '../organization-pages'
import { ProviderPage } from '../provider'
import { approvalsApi, llmProvidersApi, organizationsApi } from '@/lib/api'

vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))

vi.mock('@/lib/api', () => ({
  approvalsApi: { list: vi.fn(), approve: vi.fn(), reject: vi.fn() },
  organizationsApi: {
    getAll: vi.fn(),
    getMembers: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    addMember: vi.fn(),
    removeMember: vi.fn(),
    updateMemberRole: vi.fn(),
  },
  llmProvidersApi: { getById: vi.fn(), update: vi.fn(), test: vi.fn(), delete: vi.fn() },
}))
vi.mock('@/store/app', () => ({
  useNotifications: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}))
vi.mock('@/store/organization', () => ({
  useOrganizationStore: () => ({
    currentOrganization: { id: 'org-a', name: 'alpha-org' },
    organizations: [],
    setCurrentOrganization: vi.fn(),
    upsertOrganization: vi.fn(),
    removeOrganization: vi.fn(),
  }),
}))
// The pickers on the provider page have their own tests.
vi.mock('@/components/model-picker', () => ({ ModelPicker: () => <div data-testid="model-picker" /> }))
vi.mock('@/lib/models-api', () => ({ modelsApi: { list: vi.fn().mockResolvedValue([]), sync: vi.fn(), update: vi.fn() } }))

beforeEach(() => {
  vi.clearAllMocks()
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn()
})

describe('approvals', () => {
  const row = {
    id: 'a-1', organizationId: 'org-1', teamId: null, visibility: 'org', runId: 'run-1',
    agentId: 'agent-1', toolCallId: null, reason: 'Delete the staging database', payload: null,
    status: 'pending', decidedBy: null, decidedAt: null, decisionReason: null, expiresAt: null,
    createdAt: new Date().toISOString(),
  }
  const at = () => renderAtRoute(<ApprovalsPage />, { path: '/approvals', paths: ['/elsewhere'] })

  beforeEach(() => {
    vi.mocked(approvalsApi.list).mockResolvedValue([row] as any)
  })

  it('asks while a decision note is written and not recorded', async () => {
    const { router } = at()
    fireEvent.click(await screen.findByRole('button', { name: /Approve/ }))
    fireEvent.change(screen.getByLabelText(/Note/), { target: { value: 'Checked with the owner' } })
    await expectLeaveAsks(router)
  })

  it('leaves without asking after Cancel', async () => {
    const { router } = at()
    fireEvent.click(await screen.findByRole('button', { name: /Approve/ }))
    fireEvent.change(screen.getByLabelText(/Note/), { target: { value: 'Checked with the owner' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await expectLeavesWithoutAsking(router)
  })
})

describe('organization settings and invite', () => {
  const org = {
    id: 'org-a', name: 'alpha-org', slug: 'alpha-org', description: 'The first one', isActive: true,
    plan: 'free', memberCount: 1, createdAt: '2026-06-01T12:17:57.470Z', updatedAt: '2026-06-02T00:00:00.000Z',
  }
  const at = (tab: string) =>
    renderAtRoute(<OrganizationDetailPage />, {
      path: '/organizations/:id',
      url: `/organizations/org-a?tab=${tab}`,
      paths: ['/organizations', '/elsewhere'],
    })

  beforeEach(() => {
    vi.mocked(organizationsApi.getAll).mockResolvedValue([org] as any)
    vi.mocked(organizationsApi.getMembers).mockResolvedValue([] as any)
  })

  it('asks while the organization name is edited and not saved', async () => {
    const { router } = at('settings')
    fireEvent.change(await screen.findByLabelText('Organization name'), { target: { value: 'beta-org' } })
    await expectLeaveAsks(router)
  })

  it('leaves unchanged settings without asking', async () => {
    const { router } = at('settings')
    await screen.findByLabelText('Organization name')
    await expectLeavesWithoutAsking(router)
  })

  it('asks while an invitation is half written', async () => {
    const { router } = at('members')
    fireEvent.click(await screen.findByRole('button', { name: /Invite member/ }))
    fireEvent.change(screen.getByLabelText(/Email address/), { target: { value: 'grace@example.com' } })
    await expectLeaveAsks(router)
  })

  it('leaves without asking after the invitation is cancelled', async () => {
    const { router } = at('members')
    fireEvent.click(await screen.findByRole('button', { name: /Invite member/ }))
    fireEvent.change(screen.getByLabelText(/Email address/), { target: { value: 'grace@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await expectLeavesWithoutAsking(router)
  })
})

describe('provider settings', () => {
  const at = () =>
    renderAtRoute(<ProviderPage />, {
      path: '/models/providers/:id',
      url: '/models/providers/p1',
      paths: ['/elsewhere'],
    })

  beforeEach(() => {
    vi.mocked(llmProvidersApi.getById).mockResolvedValue({ id: 'p1', name: 'OpenAI', type: 'openai', configuration: { temperature: 0.7 } } as any)
  })

  const openAdvanced = async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Advanced' }))
    return screen.getByLabelText('Temperature')
  }

  it('asks while a setting is changed and not saved', async () => {
    const { router } = at()
    const temperature = await openAdvanced()
    fireEvent.change(temperature, { target: { value: '0.2' } })
    await expectLeaveAsks(router)
  })

  it('leaves unchanged settings without asking', async () => {
    const { router } = at()
    await openAdvanced()
    await expectLeavesWithoutAsking(router)
  })

  it('leaves without asking once the save lands', async () => {
    vi.mocked(llmProvidersApi.update).mockResolvedValue({} as any)
    const { router } = at()
    const temperature = await openAdvanced()
    fireEvent.change(temperature, { target: { value: '0.2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }))
    await waitFor(() => expect(llmProvidersApi.update).toHaveBeenCalledWith('p1', expect.objectContaining({ configuration: expect.objectContaining({ temperature: 0.2 }) })))
    await expectLeavesWithoutAsking(router)
  })
})
