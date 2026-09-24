/**
 * The gateway page's inline edit sections, and its settings page, ask
 * before a navigation throws away what was typed into them. A clean
 * section, a cancelled one and a save that lands leave without asking.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'

import { renderAtRoute } from '@/test/render-at-route'
import { expectLeaveAsks, expectLeavesWithoutAsking } from '@/test/leave-guard'
import { LEAVE_TITLE } from '@/hooks/use-leave-guard'
import { GatewayAuthSection } from '../gateway-auth-section'
import { SecurityPolicyForm } from '../security-policy-form'
import { GatewayEditPage } from '@/pages/gateway-edit'
import { gatewaysApi } from '@/lib/api'

vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))

vi.mock('@/lib/api', () => ({
  gatewaysApi: {
    getById: vi.fn(),
    update: vi.fn(),
    getAuthConfigs: vi.fn(),
    listApiKeys: vi.fn(),
    createAuthConfig: vi.fn(),
    deleteAuthConfig: vi.fn(),
    generateApiKey: vi.fn(),
    revokeApiKey: vi.fn(),
  },
}))
vi.mock('@/store/app', () => ({
  useNotifications: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}))
vi.mock('@/store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'org-1', name: 'Acme' } }),
}))
vi.mock('@/components/ui/visibility-field', () => ({ VisibilityField: () => null }))

beforeEach(() => {
  vi.clearAllMocks()
})

const at = (el: JSX.Element) => renderAtRoute(el, { path: '/gateways/gw-1', paths: ['/elsewhere'] })

describe('gateway authentication', () => {
  beforeEach(() => {
    vi.mocked(gatewaysApi.getAuthConfigs).mockResolvedValue([
      { id: 'auth-1', type: 'api_key', configuration: { keyHeader: 'x-api-key' } },
    ] as any)
    vi.mocked(gatewaysApi.listApiKeys).mockResolvedValue([] as any)
  })

  it('asks while a key name is typed into the generate form', async () => {
    const { router } = at(<GatewayAuthSection gatewayId="gw-1" gatewayName="Support" />)
    fireEvent.click(await screen.findByRole('button', { name: /Generate key/ }))
    fireEvent.change(screen.getByLabelText('Key name'), { target: { value: 'Production' } })
    await expectLeaveAsks(router)
  })

  it('leaves without asking after Cancel', async () => {
    const { router } = at(<GatewayAuthSection gatewayId="gw-1" gatewayName="Support" />)
    fireEvent.click(await screen.findByRole('button', { name: /Generate key/ }))
    fireEvent.change(screen.getByLabelText('Key name'), { target: { value: 'Production' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await expectLeavesWithoutAsking(router)
  })
})

describe('tool security policy', () => {
  const form = (isSaving = false) => (
    <SecurityPolicyForm initialPolicy={{ allowedDomains: ['api.example.com'] }} onSave={vi.fn()} onCancel={vi.fn()} isSaving={isSaving} />
  )

  it('asks once the policy is edited', async () => {
    const { router } = at(form())
    fireEvent.change(screen.getByLabelText('Allowed domains'), { target: { value: 'api.example.com, cdn.example.com' } })
    await expectLeaveAsks(router)
  })

  it('leaves an unchanged policy without asking', async () => {
    const { router } = at(form())
    await expectLeavesWithoutAsking(router)
  })
})

describe('gateway settings page', () => {
  const gateway = { id: 'gw-1', name: 'Support', endpoint: '/support', description: '', status: 'active', type: 'mcp' }
  const page = () =>
    renderAtRoute(<GatewayEditPage />, {
      path: '/gateways/:id/edit',
      url: '/gateways/gw-1/edit',
      paths: ['/gateways/:id', '/elsewhere'],
    })

  beforeEach(() => {
    vi.mocked(gatewaysApi.getById).mockResolvedValue(gateway as any)
  })

  it('asks once a setting is edited', async () => {
    const { router } = page()
    const name = await screen.findByLabelText(/^Name/)
    await waitFor(() => expect(name).toHaveValue('Support'))
    fireEvent.change(name, { target: { value: 'Support v2' } })
    await expectLeaveAsks(router)
  })

  it('leaves unchanged settings without asking', async () => {
    const { router } = page()
    await waitFor(() => expect(screen.getByLabelText(/^Name/)).toHaveValue('Support'))
    await expectLeavesWithoutAsking(router)
  })

  it('returns to the gateway without asking once the save lands', async () => {
    vi.mocked(gatewaysApi.update).mockResolvedValue({} as any)
    const { router } = page()
    const name = await screen.findByLabelText(/^Name/)
    await waitFor(() => expect(name).toHaveValue('Support'))
    fireEvent.change(name, { target: { value: 'Support v2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/gateways/gw-1'))
    expect(screen.queryByText(LEAVE_TITLE)).not.toBeInTheDocument()
  })
})
