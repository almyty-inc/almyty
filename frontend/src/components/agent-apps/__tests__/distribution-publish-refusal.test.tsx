import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'

import { render } from '../../../test/setup'
import { DistributionPanel } from '../distribution-panel'
import { agentAppsApi, type AgentApp, type AppDistribution } from '@/lib/agent-apps'

// The publish endpoint refuses with the joined list of every blocker it
// found. The panel accepted the error and never read it, so the one
// refusal in the app that goes out of its way to be actionable arrived
// as a bare "Could not publish" with no description at all.

vi.mock('@/lib/agent-apps', async () => {
  const actual = await vi.importActual<typeof import('@/lib/agent-apps')>('@/lib/agent-apps')
  return {
    ...actual,
    agentAppsApi: {
      checkDistribution: vi.fn(),
      addDistribution: vi.fn(),
      publishDistribution: vi.fn(),
      unpublishDistribution: vi.fn(),
      platforms: vi.fn().mockResolvedValue([]),
      builds: vi.fn().mockResolvedValue([]),
    },
  }
})

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, credentialsApi: { getAll: vi.fn().mockResolvedValue({ data: [] }) } }
})

const notifyError = vi.fn()
vi.mock('@/store/app', () => ({
  useNotifications: () => ({
    success: vi.fn(),
    error: notifyError,
    info: vi.fn(),
    warning: vi.fn(),
  }),
}))

const app = { slug: 'acme-support', name: 'Acme Support', agentIds: [] } as unknown as AgentApp

const distribution = (over: Partial<AppDistribution> = {}): AppDistribution =>
  ({
    id: 'd-1',
    target: 'slack',
    status: 'draft',
    configuration: {},
    gatewayId: null,
    lastBuild: null,
    ...over,
  }) as AppDistribution

describe('DistributionPanel publish refusal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(agentAppsApi.checkDistribution as any).mockResolvedValue({ ok: true, refusals: [] })
    ;(agentAppsApi.addDistribution as any).mockResolvedValue({})
  })

  it('repeats the blockers the backend listed', async () => {
    ;(agentAppsApi.publishDistribution as any).mockRejectedValue({
      response: {
        status: 400,
        data: {
          error: {
            code: 'DISTRIBUTION_NOT_SHIPPABLE',
            message: 'No cost cap is set; white label is not on this plan; no agents are attached.',
          },
        },
      },
    })

    render(<DistributionPanel app={app} distribution={distribution()} onSaved={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: /^Publish$/ }))

    await waitFor(() =>
      expect(notifyError).toHaveBeenCalledWith(
        'Could not publish',
        'No cost cap is set; white label is not on this plan; no agents are attached.',
      ),
    )
  })

  it('repeats the reason an unpublish was refused too', async () => {
    ;(agentAppsApi.unpublishDistribution as any).mockRejectedValue({
      response: { status: 409, data: { error: { message: 'A build is still running.' } } },
    })

    render(
      <DistributionPanel
        app={app}
        distribution={distribution({ status: 'live' })}
        onSaved={vi.fn()}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /^Unpublish$/ }))

    await waitFor(() =>
      expect(notifyError).toHaveBeenCalledWith(
        'Could not unpublish',
        'A build is still running.',
      ),
    )
  })
})
