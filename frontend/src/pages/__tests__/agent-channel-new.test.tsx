import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider, useParams } from 'react-router-dom'

import { AgentChannelNewPage } from '../agent-channel-new'

// The shared setup stubs useNavigate; this test follows a real navigation.
vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))
vi.mock('@/components/channels/channel-page-loader', async () => {
  const actual = await vi.importActual<typeof import('@/components/channels/channel-page-loader')>(
    '@/components/channels/channel-page-loader',
  )
  return { ...actual, WithAgent: ({ children }: any) => children({ id: 'agent-1', name: 'Support' }) }
})
vi.mock('@/lib/agent-channels', async () => {
  const actual = await vi.importActual<typeof import('@/lib/agent-channels')>('@/lib/agent-channels')
  return {
    ...actual,
    agentChannelsApi: { add: vi.fn().mockResolvedValue({ id: 'c-new', type: 'slack' }), list: vi.fn().mockResolvedValue([]) },
  }
})
const notify = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('@/store/app', () => ({ useNotifications: () => notify }))

import { agentChannelsApi } from '@/lib/agent-channels'

function Opened() {
  const { channelId } = useParams()
  return <p data-testid="opened">{channelId}</p>
}

const addButton = (name = 'Add channel') => screen.getByRole('button', { name })

/** Adding a channel: one row per kind; picking one selects it, Add channel adds it and opens its page. */
describe('Add channel', () => {
  it('lists every channel as a choice and opens the one added', async () => {
    vi.mocked(agentChannelsApi.add).mockReset()
    vi.mocked(agentChannelsApi.add).mockResolvedValue({ id: 'c-new', type: 'slack' } as any)
    const router = open()

    expect(await screen.findByRole('heading', { name: 'Add channel' })).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: 'Kind of channel' })).toBeInTheDocument()
    for (const id of ['web', 'widget', 'slack', 'whatsapp', 'whatsapp_cloud', 'desktop', 'tui', 'a2a']) {
      expect(screen.getByTestId(`channel-${id}`)).toHaveAttribute('role', 'radio')
    }
    expect(screen.queryByTestId('channel-binary')).toBeNull()

    fireEvent.click(screen.getByTestId('channel-slack'))
    expect(screen.getByTestId('channel-slack')).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(addButton())
    await waitFor(() => expect(agentChannelsApi.add).toHaveBeenCalledWith('agent-1', { type: 'slack' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/agents/agent-1/channels/c-new'))
  })

  // Opening "Web chat" in the list used to add a web chat on the spot.
  it('picking a kind adds nothing until Add channel is pressed', async () => {
    vi.mocked(agentChannelsApi.add).mockReset()
    vi.mocked(agentChannelsApi.list).mockResolvedValue([])
    open()
    await screen.findByRole('heading', { name: 'Add channel' })
    expect(addButton()).toBeDisabled()

    fireEvent.click(screen.getByTestId('channel-web'))
    await new Promise((r) => setTimeout(r, 0))
    expect(agentChannelsApi.add).not.toHaveBeenCalled()
    expect(screen.getByTestId('channel-web')).toHaveAttribute('aria-checked', 'true')
    expect(addButton()).toBeEnabled()
  })

  it('draws a different icon for each kind, the platform mark where there is one', async () => {
    open()
    await screen.findByRole('heading', { name: 'Add channel' })
    const iconOf = (type: string) => {
      const svg = screen.getByTestId(`channel-${type}`).querySelector('svg[data-brand], svg[data-channel-icon]')
      expect(svg, `${type} has an icon`).not.toBeNull()
      return svg!.getAttribute('data-brand') ? `brand:${svg!.querySelector('path')?.getAttribute('d')}` : `glyph:${svg!.getAttribute('class')}:${svg!.innerHTML}`
    }
    for (const type of ['whatsapp', 'telegram', 'discord', 'google_chat', 'signal', 'matrix']) {
      expect(screen.getByTestId(`channel-${type}`).querySelector(`svg[data-brand="${type}"]`)).not.toBeNull()
    }
    const distinct = ['web', 'widget', 'slack', 'microsoft_teams', 'google_chat', 'whatsapp', 'telegram', 'discord', 'signal', 'matrix', 'irc', 'email', 'sms', 'webhook', 'desktop', 'tui', 'a2a']
    expect(new Set(distinct.map(iconOf)).size).toBe(distinct.length)
  })

  // A desktop app opens the agent's web chat. On an agent with none, the
  // page says before the click that a web chat comes with it, inline.
  it('adds the web chat with a desktop app when the agent has none, and says so first', async () => {
    vi.mocked(agentChannelsApi.add).mockReset()
    vi.mocked(agentChannelsApi.list).mockResolvedValue([])
    vi.mocked(agentChannelsApi.add).mockImplementation(async (_agent, body) =>
      (body.type === 'web' ? { id: 'c-web', type: 'web', name: 'Web chat' } : { id: 'c-desk', type: 'desktop', name: 'Desktop app' }) as any,
    )
    const router = open()
    await screen.findByRole('heading', { name: 'Add channel' })
    await waitFor(() => expect(agentChannelsApi.list).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 0))
    fireEvent.click(screen.getByTestId('channel-desktop'))
    const note = await screen.findByTestId('desktop-needs-web-chat')
    expect(note).toHaveTextContent("A desktop app opens Support's web chat, and Support has none yet")
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(agentChannelsApi.add).not.toHaveBeenCalled()

    fireEvent.click(addButton('Add web chat and desktop app'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/agents/agent-1/channels/c-desk'))
    expect(vi.mocked(agentChannelsApi.add).mock.calls.map((c) => c[1])).toEqual([{ type: 'web' }, { type: 'desktop' }])
  })

  it('adds only the desktop app when the agent has a web chat', async () => {
    vi.mocked(agentChannelsApi.add).mockReset()
    vi.mocked(agentChannelsApi.list).mockResolvedValue([{ id: 'c-web', type: 'web' }] as any)
    vi.mocked(agentChannelsApi.add).mockResolvedValue({ id: 'c-desk', type: 'desktop', name: 'Desktop app' } as any)
    const router = open()
    await screen.findByRole('heading', { name: 'Add channel' })
    await waitFor(() => expect(agentChannelsApi.list).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 0))
    fireEvent.click(screen.getByTestId('channel-desktop'))
    expect(screen.queryByTestId('desktop-needs-web-chat')).toBeNull()
    fireEvent.click(addButton())
    await waitFor(() => expect(router.state.location.pathname).toBe('/agents/agent-1/channels/c-desk'))
    expect(vi.mocked(agentChannelsApi.add).mock.calls.map((c) => c[1])).toEqual([{ type: 'desktop' }])
  })

  it('drops the web chat note when another kind is picked', async () => {
    vi.mocked(agentChannelsApi.add).mockReset()
    vi.mocked(agentChannelsApi.list).mockResolvedValue([])
    open()
    await waitFor(() => expect(agentChannelsApi.list).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 0))
    fireEvent.click(await screen.findByTestId('channel-desktop'))
    expect(await screen.findByTestId('desktop-needs-web-chat')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('channel-tui'))
    expect(screen.queryByTestId('desktop-needs-web-chat')).toBeNull()
    expect(agentChannelsApi.add).not.toHaveBeenCalled()
  })

  // iMessage has no public API, so it is reached through a relay. Both
  // relays are offered, as two rows that read "iMessage" with the relay
  // underneath, and the one picked is the channel's type.
  it.each([
    ['imessage_sendblue', 'Via Sendblue'],
    ['imessage_loopmessage', 'Via LoopMessage'],
  ] as const)('offers iMessage %s and adds that relay when picked', async (type, hint) => {
    vi.mocked(agentChannelsApi.add).mockReset()
    vi.mocked(agentChannelsApi.list).mockResolvedValue([])
    vi.mocked(agentChannelsApi.add).mockResolvedValue({ id: 'c-imsg', type, name: 'iMessage' } as any)
    const router = open()
    const row = await screen.findByTestId(`channel-${type}`)
    expect(row).toHaveTextContent('iMessage')
    expect(row).toHaveTextContent(hint)

    fireEvent.click(row)
    fireEvent.click(addButton())
    await waitFor(() => expect(agentChannelsApi.add).toHaveBeenCalledWith('agent-1', { type }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/agents/agent-1/channels/c-imsg'))
  })
})

function open() {
  const router = createMemoryRouter(
    [
      { path: '/agents/:id/channels/new', element: <AgentChannelNewPage /> },
      { path: '/agents/:id/channels/:channelId', element: <Opened /> },
    ],
    { initialEntries: ['/agents/agent-1/channels/new'] },
  )
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}