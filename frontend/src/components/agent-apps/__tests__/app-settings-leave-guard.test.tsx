/**
 * App settings edit in place on the app page. A change not yet saved asks
 * before a navigation throws it away; saved or untouched settings do not.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'

import { renderAtRoute } from '@/test/render-at-route'
import { expectLeaveAsks, expectLeavesWithoutAsking } from '@/test/leave-guard'
import { AppSettingsPanel } from '../app-settings-panel'
import { agentAppsApi, type AgentApp } from '@/lib/agent-apps'

vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))

vi.mock('@/lib/agent-apps', async () => {
  const actual = await vi.importActual<typeof import('@/lib/agent-apps')>('@/lib/agent-apps')
  return { ...actual, agentAppsApi: { update: vi.fn() } }
})
vi.mock('@/store/app', () => ({
  useNotifications: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}))

const app = {
  slug: 'acme-support',
  name: 'Acme Support',
  branding: {},
  authMode: 'public_link',
  capabilities: {},
  limits: null,
  privacy: null,
  isActive: true,
} as unknown as AgentApp

beforeEach(() => {
  vi.clearAllMocks()
})

const at = () =>
  renderAtRoute(<AppSettingsPanel app={app} onSaved={vi.fn()} />, { path: '/apps/acme-support', paths: ['/elsewhere'] })

describe('app settings', () => {
  it('asks once a setting is changed and not saved', async () => {
    const { router } = at()
    fireEvent.change(screen.getByLabelText('Name users see'), { target: { value: 'Acme Help' } })
    await expectLeaveAsks(router)
  })

  it('leaves untouched settings without asking', async () => {
    const { router } = at()
    await expectLeavesWithoutAsking(router)
  })

  it('leaves without asking once the change is saved', async () => {
    vi.mocked(agentAppsApi.update).mockResolvedValue({} as any)
    const { router } = at()
    fireEvent.change(screen.getByLabelText('Name users see'), { target: { value: 'Acme Help' } })
    fireEvent.click(screen.getByRole('button', { name: /Save/ }))
    await waitFor(() => expect(agentAppsApi.update).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByRole('button', { name: /Save/ })).not.toBeDisabled())
    await expectLeavesWithoutAsking(router)
  })
})
