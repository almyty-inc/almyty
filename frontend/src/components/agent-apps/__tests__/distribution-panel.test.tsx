import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'

import { render } from '../../../test/setup'
import { DistributionPanel } from '../distribution-panel'
import { agentAppsApi, type AgentApp, type AppDistribution } from '@/lib/agent-apps'

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

const app = { slug: 'acme-support', name: 'Acme Support' } as AgentApp

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

describe('DistributionPanel', () => {
  const onSaved = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    ;(agentAppsApi.checkDistribution as any).mockResolvedValue({ ok: true, refusals: [] })
    ;(agentAppsApi.publishDistribution as any).mockResolvedValue({ status: 'live' })
    ;(agentAppsApi.unpublishDistribution as any).mockResolvedValue({ status: 'draft' })
    ;(agentAppsApi.addDistribution as any).mockResolvedValue({})
  })

  it('offers to publish a distribution that is only a draft', async () => {
    render(<DistributionPanel app={app} distribution={distribution()} onSaved={onSaved} />)

    fireEvent.click(await screen.findByRole('button', { name: /^Publish$/ }))

    await waitFor(() =>
      expect(agentAppsApi.publishDistribution).toHaveBeenCalledWith('acme-support', 'slack'),
    )
  })

  it('offers to take down one that is live, not to publish it again', async () => {
    render(
      <DistributionPanel
        app={app}
        distribution={distribution({ status: 'live' })}
        onSaved={onSaved}
      />,
    )

    expect(screen.queryByRole('button', { name: /^Publish$/ })).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: /Take it down/ }))

    await waitFor(() =>
      expect(agentAppsApi.unpublishDistribution).toHaveBeenCalledWith('acme-support', 'slack'),
    )
  })

  it('says taking it down keeps the address, so nobody re-registers a Slack app', async () => {
    render(
      <DistributionPanel
        app={app}
        distribution={distribution({ status: 'live' })}
        onSaved={onSaved}
      />,
    )

    expect(await screen.findByText(/keeps its address/i)).toBeInTheDocument()
  })

  it('does not offer to publish something that ships as a file', async () => {
    // A downloadable artifact has nothing to stand up and nothing to
    // take down.
    render(
      <DistributionPanel app={app} distribution={distribution({ target: 'tui' })} onSaved={onSaved} />,
    )

    // Wait for the build controls, which only a buildable target has.
    await screen.findByRole('button', { name: /Build/ })
    expect(screen.queryByRole('button', { name: /^Publish$/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Take it down/ })).toBeNull()
  })

  it('shows what is stopping this distribution from shipping', async () => {
    ;(agentAppsApi.checkDistribution as any).mockResolvedValue({
      ok: false,
      refusals: [{ code: 'PUBLIC_NEEDS_COST_CAP', message: 'It needs a cost cap first.' }],
    })
    render(<DistributionPanel app={app} distribution={distribution()} onSaved={onSaved} />)

    expect(await screen.findByText('It needs a cost cap first.')).toBeInTheDocument()
  })

  it('keeps the settings it did not touch when saving one of them', async () => {
    // addDistribution is the save path, and sending only the edited
    // field used to be enough to drop the rest.
    render(
      <DistributionPanel
        app={app}
        distribution={distribution({
          target: 'desktop',
          configuration: { bundleId: 'com.acme.app', signingCredentialId: 'cred-1' },
        })}
        onSaved={onSaved}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /^Save$/ }))

    await waitFor(() =>
      expect(agentAppsApi.addDistribution).toHaveBeenCalledWith(
        'acme-support',
        'desktop',
        expect.objectContaining({ signingCredentialId: 'cred-1', bundleId: 'com.acme.app' }),
      ),
    )
  })

  it('tells a channel where its credentials come from', async () => {
    render(<DistributionPanel app={app} distribution={distribution()} onSaved={onSaved} />)

    expect(await screen.findByText(/needs its own credentials/i)).toBeInTheDocument()
  })
})
