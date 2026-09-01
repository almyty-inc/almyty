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

const app = { slug: 'acme-support', name: 'Acme Support', agentIds: [] } as unknown as AgentApp

const twoAgents = {
  ...app,
  agentIds: ['triage-1', 'billing-2'],
} as unknown as AgentApp

const AGENTS = [
  { id: 'triage-1', name: 'Triage' },
  { id: 'billing-2', name: 'Billing' },
]

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

  it('offers to unpublish one that is live, not to publish it again', async () => {
    render(
      <DistributionPanel
        app={app}
        distribution={distribution({ status: 'live' })}
        onSaved={onSaved}
      />,
    )

    expect(screen.queryByRole('button', { name: /^Publish$/ })).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: /Unpublish/ }))

    await waitFor(() =>
      expect(agentAppsApi.unpublishDistribution).toHaveBeenCalledWith('acme-support', 'slack'),
    )
  })

  it('says unpublish keeps the address, so nobody re-registers a Slack app', async () => {
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
    // unpublish.
    render(
      <DistributionPanel app={app} distribution={distribution({ target: 'tui' })} onSaved={onSaved} />,
    )

    // Wait for the build controls, which only a buildable target has.
    await screen.findByRole('button', { name: /Build/ })
    expect(screen.queryByRole('button', { name: /^Publish$/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Unpublish/ })).toBeNull()
  })

  it('shows what is stopping this distribution from shipping', async () => {
    ;(agentAppsApi.checkDistribution as any).mockResolvedValue({
      ok: false,
      refusals: [{ code: 'PUBLIC_NEEDS_COST_CAP', message: 'It needs a cost cap first.' }],
    })
    render(<DistributionPanel app={app} distribution={distribution()} onSaved={onSaved} />)

    expect(await screen.findByText('It needs a cost cap first.')).toBeInTheDocument()
  })

  it('sends only what changed, not the masked config it was given', async () => {
    // The API returns stored secrets masked, so re-sending the whole
    // configuration would write the mask back over the real value. The
    // backend merges a partial patch, so the client sends just the edit.
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

    await waitFor(() => expect(agentAppsApi.addDistribution).toHaveBeenCalled())
    const patch = (agentAppsApi.addDistribution as any).mock.calls.at(-1)[2]
    // The bundle id is the field this button edits; the credential id it
    // was given is not re-sent.
    expect(patch).toHaveProperty('bundleId')
    expect(patch).not.toHaveProperty('signingCredentialId')
  })

  describe('which agent answers', () => {
    it('does not ask when the product has only one', async () => {
      // There is no choice to make.
      render(
        <DistributionPanel
          app={{ ...app, agentIds: ['triage-1'] } as unknown as AgentApp}
          distribution={distribution()}
          agents={AGENTS}
          onSaved={onSaved}
        />,
      )
      await screen.findByRole('button', { name: /^Publish$/ })
      expect(screen.queryByLabelText('Answered by')).toBeNull()
    })

    it('offers the product default first, naming it', async () => {
      render(
        <DistributionPanel
          app={twoAgents}
          distribution={distribution()}
          agents={AGENTS}
          onSaved={onSaved}
        />,
      )
      expect(await screen.findByLabelText('Answered by')).toHaveTextContent(
        /Triage \(the product default\)/,
      )
    })

    it('saves the agent this surface should answer with', async () => {
      // A billing channel should be able to reach the billing agent.
      render(
        <DistributionPanel
          app={twoAgents}
          distribution={distribution()}
          agents={AGENTS}
          onSaved={onSaved}
        />,
      )

      fireEvent.click(await screen.findByLabelText('Answered by'))
      fireEvent.click(await screen.findByText('Billing'))

      await waitFor(() =>
        expect(agentAppsApi.addDistribution).toHaveBeenCalledWith(
          'acme-support',
          'slack',
          expect.objectContaining({ agentId: 'billing-2' }),
        ),
      )
    })

    it('clears the choice back to the default rather than storing the id', async () => {
      render(
        <DistributionPanel
          app={twoAgents}
          distribution={distribution({ configuration: { agentId: 'billing-2' } })}
          agents={AGENTS}
          onSaved={onSaved}
        />,
      )

      fireEvent.click(await screen.findByLabelText('Answered by'))
      fireEvent.click(await screen.findByText(/the product default/))

      await waitFor(() =>
        expect(agentAppsApi.addDistribution).toHaveBeenCalledWith(
          'acme-support',
          'slack',
          expect.objectContaining({ agentId: '' }),
        ),
      )
    })

    it('does not ask for something that ships as a file', async () => {
      render(
        <DistributionPanel
          app={twoAgents}
          distribution={distribution({ target: 'tui' })}
          agents={AGENTS}
          onSaved={onSaved}
        />,
      )
      await screen.findByRole('button', { name: /Build/ })
      expect(screen.queryByLabelText('Answered by')).toBeNull()
    })
  })

  describe('channel credentials', () => {
    it('offers a field for each credential the platform needs', async () => {
      // A publish is refused without these, so the panel has to let the
      // operator enter them rather than pointing elsewhere.
      render(<DistributionPanel app={app} distribution={distribution()} onSaved={onSaved} />)

      expect(await screen.findByLabelText('Bot token')).toBeInTheDocument()
      expect(screen.getByLabelText('Signing secret')).toBeInTheDocument()
    })

    it('masks the secret fields', async () => {
      render(<DistributionPanel app={app} distribution={distribution()} onSaved={onSaved} />)
      const token = (await screen.findByLabelText('Bot token')) as HTMLInputElement
      expect(token.type).toBe('password')
    })

    it('saves only the credentials that changed', async () => {
      // A stored secret comes back masked, so an untouched field must
      // not be written back over the real value.
      render(
        <DistributionPanel
          app={app}
          distribution={distribution({ configuration: { signing_secret: '••••' } })}
          onSaved={onSaved}
        />,
      )

      fireEvent.change(await screen.findByLabelText('Bot token'), {
        target: { value: 'xoxb-real' },
      })
      fireEvent.click(screen.getByRole('button', { name: /Save credentials/ }))

      await waitFor(() =>
        expect(agentAppsApi.addDistribution).toHaveBeenCalledWith(
          'acme-support',
          'slack',
          expect.objectContaining({ bot_token: 'xoxb-real' }),
        ),
      )
      // signing_secret was not touched, so it is not in the patch.
      const patch = (agentAppsApi.addDistribution as any).mock.calls.at(-1)[2]
      expect(patch).not.toHaveProperty('signing_secret')
    })
  })
})
