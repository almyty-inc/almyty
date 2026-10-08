import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const entitlement = vi.hoisted(() => ({ enabled: false, isLoading: false }))
vi.mock('@/hooks/use-entitlement', () => ({ useEntitlement: () => entitlement }))

const api = vi.hoisted(() => ({ apiGet: vi.fn(), addGrant: vi.fn() }))
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<any>('@/lib/api')
  return { ...actual, apiGet: api.apiGet }
})
vi.mock('@/lib/connections-api', () => ({ connectionsApi: { addGrant: api.addGrant } }))

import { ActsAs } from '../capabilities-section'

const AGENT = 'a-1'

const renderActsAs = (agentConfig: Record<string, any>, onChange = vi.fn(), agentId: string | undefined = AGENT) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ActsAs agentId={agentId} agentConfig={agentConfig} onChange={onChange} />
      </MemoryRouter>
    </QueryClientProvider>,
  )

const UNREACHABLE = [
  { kind: 'provider', id: 'p-1', name: 'My Claude', neededFor: 'Its model', scope: 'private', canGrant: false, note: 'A private model provider cannot be shared with an agent.' },
  { kind: 'connection', id: 'c-1', name: 'OpenAI key', neededFor: 'The key for its model (Company OpenAI)', scope: 'personal', canGrant: true },
]

describe('who the agent acts as', () => {
  beforeEach(() => {
    // Radix Select in jsdom.
    if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn()
    entitlement.enabled = false
    entitlement.isLoading = false
    api.apiGet.mockReset()
    api.addGrant.mockReset()
  })

  it('acts as its owner by default, and lists nothing', () => {
    renderActsAs({})
    expect(screen.getByLabelText('Acts as')).toHaveTextContent('You, its owner')
    expect(screen.getByTestId('acts-as-hint')).toHaveTextContent('It uses what you can use')
    expect(api.apiGet).not.toHaveBeenCalled()
  })

  it('is locked to the owner without the Business plan, and says where to get it', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderActsAs({}, onChange)
    expect(screen.getByTestId('acts-as-locked')).toHaveTextContent('part of the Business plan')
    expect(screen.getByRole('link', { name: 'See plans' })).toHaveAttribute('href', '/settings/billing')
    await user.click(screen.getByLabelText('Acts as'))
    expect(screen.getByRole('option', { name: 'Itself, with its own access' })).toHaveAttribute('aria-disabled', 'true')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('writes runAs when the plan includes it', async () => {
    entitlement.enabled = true
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderActsAs({}, onChange)
    expect(screen.queryByTestId('acts-as-locked')).not.toBeInTheDocument()
    await user.click(screen.getByLabelText('Acts as'))
    await user.click(screen.getByRole('option', { name: 'Itself, with its own access' }))
    expect(onChange).toHaveBeenLastCalledWith({ runAs: 'agent' })
  })

  it('says a lapsed plan pauses its runs rather than running them as the owner', () => {
    api.apiGet.mockResolvedValue([])
    renderActsAs({ runAs: 'agent' })
    expect(screen.getByTestId('acts-as-hint')).toHaveTextContent('only the organization\'s model providers and the connections given to it')
    expect(screen.getByTestId('acts-as-locked')).toHaveTextContent('paused rather than run as you')
  })

  it('lists what it would not reach as itself, with a grant button only where a grant opens it', async () => {
    entitlement.enabled = true
    api.apiGet.mockResolvedValue(UNREACHABLE)
    renderActsAs({ runAs: 'agent' })
    await waitFor(() => expect(screen.getByTestId('acts-as-unreachable')).toBeInTheDocument())
    expect(api.apiGet).toHaveBeenCalledWith(`/agents/${AGENT}/identity/unreachable`)
    const provider = screen.getByTestId('unreachable-p-1')
    expect(provider).toHaveTextContent('My Claude')
    expect(provider).toHaveTextContent('private model provider')
    expect(provider).toHaveTextContent('cannot be shared with an agent')
    expect(provider.querySelector('button')).toBeNull()
    expect(screen.getByRole('button', { name: 'Let this agent use my OpenAI key' })).toBeInTheDocument()
    // Nothing is granted without the click.
    expect(api.addGrant).not.toHaveBeenCalled()
  })

  it('grants a connection to the agent on its click, and checks again', async () => {
    entitlement.enabled = true
    const user = userEvent.setup()
    api.apiGet.mockResolvedValueOnce(UNREACHABLE).mockResolvedValueOnce([UNREACHABLE[0]])
    api.addGrant.mockResolvedValue({ id: 'g-1' })
    renderActsAs({ runAs: 'agent' })
    await user.click(await screen.findByRole('button', { name: 'Let this agent use my OpenAI key' }))
    expect(api.addGrant).toHaveBeenCalledWith('c-1', { principalType: 'agent', principalId: AGENT })
    await waitFor(() => expect(screen.queryByTestId('unreachable-c-1')).not.toBeInTheDocument())
    expect(api.apiGet).toHaveBeenCalledTimes(2)
  })

  it('says when nothing is out of reach, and asks to save a new agent first', async () => {
    entitlement.enabled = true
    api.apiGet.mockResolvedValue([])
    const { unmount } = renderActsAs({ runAs: 'agent' })
    expect(await screen.findByTestId('acts-as-reach-ok')).toBeInTheDocument()
    unmount()
    renderActsAs({ runAs: 'agent' }, vi.fn(), '')
    expect(screen.getByTestId('acts-as-unsaved')).toBeInTheDocument()
  })
})
