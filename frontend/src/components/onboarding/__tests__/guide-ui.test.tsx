import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { render } from '@/test/setup'

import type { OnboardingState } from '@/lib/api'

const api = vi.hoisted(() => ({
  get: vi.fn(),
  setDismissed: vi.fn(),
  dismissIntro: vi.fn(),
  resetIntros: vi.fn(),
}))

vi.mock('@/store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'org-1', name: 'Acme', slug: 'acme' } }),
}))
vi.mock('@/store/app', () => ({
  useNotifications: () => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))
vi.mock('@/lib/analytics', () => ({ captureEvent: vi.fn() }))
vi.mock('@/lib/api', () => ({ onboardingApi: api }))

import { GuidePage } from '@/pages/guide'
import { GuideCard } from '../guide-card'
import { GuidePill } from '../guide-pill'
import { PageIntro } from '../page-intro'
import { PAGE_INTROS } from '../page-intros'

const KEYS = [
  'provider', 'api', 'tools', 'gateway', 'first_call', 'external_client',
  'agent', 'agent_run', 'app', 'distribution', 'runner',
] as const

function state(done: Partial<Record<(typeof KEYS)[number], boolean>> = {}, over: Partial<OnboardingState> = {}): OnboardingState {
  return {
    steps: Object.fromEntries(KEYS.map((k) => [k, !!done[k]])) as OnboardingState['steps'],
    links: { gateway: null, agent: null, app: null },
    dismissed: false,
    dismissedIntros: [],
    activatedRealAt: null,
    ...over,
  }
}

const HALF = state(
  { api: true, tools: true, gateway: true, provider: true },
  {
    links: {
      gateway: { id: 'gw-1', name: 'Weather API', type: 'mcp', endpoint: '/weather-api' },
      agent: null,
      app: null,
    },
  },
)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GuidePage', () => {
  it('a brand-new account: every journey, nothing done, next step is importing an API', async () => {
    api.get.mockResolvedValue(state())
    render(<GuidePage />)
    expect(await screen.findByRole('heading', { name: 'Guide' })).toBeInTheDocument()
    for (const title of ['Give an AI your API', 'Build an agent', 'Put it where people are', 'Run it on your machines']) {
      expect(screen.getByRole('heading', { name: title })).toBeInTheDocument()
    }
    expect(screen.getByText(/0 of 10 steps done/)).toBeInTheDocument()
    const next = screen.getByTestId('next-step')
    expect(within(next).getByText('Import an API', { selector: 'p' })).toBeInTheDocument()
    expect(within(next).getByTestId('next-step-link')).toHaveAttribute('href', '/apis/new')
    expect(within(next).getByTestId('next-step-place')).toHaveTextContent('Opens APIs › Connect new API')
    // No command until there is a gateway to connect to.
    expect(screen.queryByTestId('connect-command')).not.toBeInTheDocument()
    expect(document.querySelectorAll('[data-done="true"]')).toHaveLength(0)
  })

  it('a half-set-up account: ticks what exists and shows the real command for its gateway', async () => {
    api.get.mockResolvedValue(HALF)
    render(<GuidePage />)
    await screen.findByRole('heading', { name: 'Guide' })
    for (const key of ['api', 'tools', 'gateway', 'provider']) {
      expect(screen.getByTestId(`step-${key}`)).toHaveAttribute('data-done', 'true')
    }
    expect(screen.getByTestId('step-external_client')).toHaveAttribute('data-done', 'false')
    // The client step links to this gateway's Integrations tab and says so.
    expect(screen.getByTestId('step-external_client-link')).toHaveAttribute('href', '/gateways/gw-1?tab=integrations')
    expect(screen.getByTestId('step-external_client-place')).toHaveTextContent('Opens Gateways › Weather API › Integrations')
    expect(screen.getByTestId('connect-command')).toHaveTextContent(
      `claude mcp add weather-api --transport http ${window.location.origin}/acme/weather-api`,
    )
    // It is the step the guide suggests next (a journey already started).
    expect(within(screen.getByTestId('next-step')).getByText(/Connect Claude Code/)).toBeInTheDocument()
  })

  it('has exactly one gradient call to action', async () => {
    api.get.mockResolvedValue(HALF)
    render(<GuidePage />)
    await screen.findByRole('heading', { name: 'Guide' })
    expect(document.querySelectorAll('a.bg-gradient-to-r, button.bg-gradient-to-r')).toHaveLength(1)
  })

  it('brings the card back to the dashboard after it was hidden', async () => {
    api.get.mockResolvedValue(state({}, { dismissed: true }))
    api.setDismissed.mockResolvedValue(state())
    render(<GuidePage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Show on dashboard' }))
    await waitFor(() => expect(api.setDismissed).toHaveBeenCalledWith('org-1', false))
    expect(await screen.findByRole('button', { name: 'Hide from dashboard' })).toBeInTheDocument()
  })

  it('offers to bring closed page tips back', async () => {
    api.get.mockResolvedValue(state({}, { dismissedIntros: ['apis', 'tools'] }))
    api.resetIntros.mockResolvedValue(state())
    render(<GuidePage />)
    expect(await screen.findByText(/closed the tip line on 2 pages/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show page tips again' }))
    await waitFor(() => expect(api.resetIntros).toHaveBeenCalledWith('org-1'))
    await waitFor(() => expect(screen.queryByText(/closed the tip line/)).not.toBeInTheDocument())
  })

  it('says so when everything is done', async () => {
    api.get.mockResolvedValue(state(Object.fromEntries(KEYS.map((k) => [k, true]))))
    render(<GuidePage />)
    expect(await screen.findByTestId('guide-complete')).toBeInTheDocument()
    expect(screen.queryByTestId('next-step')).not.toBeInTheDocument()
  })
})

describe('GuideCard (dashboard)', () => {
  it('is a compact entry point: next step, progress by job, link to the guide', () => {
    const onDismiss = vi.fn()
    render(<GuideCard state={HALF} onDismiss={onDismiss} />)
    expect(screen.getByText(/4 of 10 steps done/)).toBeInTheDocument()
    expect(screen.getByTestId('guide-card-open')).toHaveAttribute('href', '/guide')
    const next = screen.getByTestId('next-step')
    expect(within(next).getByTestId('next-step-link')).toHaveAttribute('href', '/gateways/gw-1?tab=integrations')
    const jobs = screen.getByRole('list', { name: 'Progress by job' })
    expect(within(jobs).getAllByRole('listitem')).toHaveLength(4)
    expect(within(jobs).getByText('3/4')).toBeInTheDocument()
    // Not the old three generic lines.
    expect(screen.queryByText(/Three steps/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Hide the guide from the dashboard' }))
    expect(onDismiss).toHaveBeenCalled()
  })
})

describe('GuidePill (sidebar)', () => {
  it('always links to the guide and shows progress until everything is done', async () => {
    api.get.mockResolvedValue(HALF)
    render(<GuidePill />)
    const link = await screen.findByRole('link', { name: 'Guide, 4 of 10 steps done' })
    expect(link).toHaveAttribute('href', '/guide')
  })

  it('stays after the dashboard card is dismissed', async () => {
    api.get.mockResolvedValue(state({}, { dismissed: true }))
    render(<GuidePill />)
    expect(await screen.findByRole('link', { name: /^Guide/ })).toHaveAttribute('href', '/guide')
  })

  it('drops the counter once all steps are done', async () => {
    api.get.mockResolvedValue(state(Object.fromEntries(KEYS.map((k) => [k, true]))))
    render(<GuidePill />)
    await waitFor(() => expect(screen.getByRole('link', { name: 'Guide' })).toBeInTheDocument())
  })
})

describe('PageIntro', () => {
  it('says what the page is and links to the guide', async () => {
    api.get.mockResolvedValue(state())
    render(<PageIntro topic="gateways" />)
    const note = await screen.findByTestId('page-intro-gateways')
    expect(note).toHaveTextContent(PAGE_INTROS.gateways.text)
    expect(within(note).getByRole('link', { name: 'Open the guide' })).toHaveAttribute('href', '/guide')
  })

  it('closes for this user and tells the server which one', async () => {
    api.get.mockResolvedValue(state())
    api.dismissIntro.mockResolvedValue(state({}, { dismissedIntros: ['gateways'] }))
    render(<PageIntro topic="gateways" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Hide this tip' }))
    await waitFor(() => expect(api.dismissIntro).toHaveBeenCalledWith('org-1', 'gateways'))
    await waitFor(() => expect(screen.queryByTestId('page-intro-gateways')).not.toBeInTheDocument())
  })

  it('stays closed on the next visit, and only for its own page', async () => {
    api.get.mockResolvedValue(state({}, { dismissedIntros: ['gateways'] }))
    render(
      <>
        <PageIntro topic="gateways" />
        <PageIntro topic="apis" />
      </>,
    )
    expect(await screen.findByTestId('page-intro-apis')).toBeInTheDocument()
    expect(screen.queryByTestId('page-intro-gateways')).not.toBeInTheDocument()
  })

  it('shows nothing before preferences load, so a closed tip never flashes', () => {
    api.get.mockReturnValue(new Promise(() => {}))
    render(<PageIntro topic="apis" />)
    expect(screen.queryByTestId('page-intro-apis')).not.toBeInTheDocument()
  })
})
