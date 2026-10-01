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

/** Adding a channel: one tile per kind, picking one adds it and opens its page. */
describe('Add channel', () => {
  it('offers every channel as a tile and opens the one picked', async () => {
    vi.mocked(agentChannelsApi.add).mockResolvedValue({ id: 'c-new', type: 'slack' } as any)
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

    expect(await screen.findByRole('heading', { name: 'Add channel' })).toBeInTheDocument()
    for (const id of ['web', 'widget', 'slack', 'whatsapp', 'whatsapp_cloud', 'desktop', 'tui', 'a2a']) {
      expect(screen.getByTestId(`channel-${id}`)).toBeInTheDocument()
    }
    expect(screen.queryByTestId('channel-binary')).toBeNull()

    fireEvent.click(screen.getByTestId('channel-slack'))
    await waitFor(() => expect(agentChannelsApi.add).toHaveBeenCalledWith('agent-1', { type: 'slack' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/agents/agent-1/channels/c-new'))
  })

  const open = () => {
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

  // A desktop app opens the agent's web chat. On an agent with none, the
  // same flow offers to add the web chat too, inline, not in a dialog.
  it('offers to add the web chat with a desktop app when the agent has none', async () => {
    vi.mocked(agentChannelsApi.add).mockReset()
    vi.mocked(agentChannelsApi.list).mockResolvedValue([])
    vi.mocked(agentChannelsApi.add).mockImplementation(async (_agent, body) =>
      (body.type === 'web' ? { id: 'c-web', type: 'web', name: 'Web chat' } : { id: 'c-desk', type: 'desktop', name: 'Desktop app' }) as any,
    )
    const router = open()
    await screen.findByRole('heading', { name: 'Add channel' })
    await waitFor(() => expect(agentChannelsApi.list).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId('channel-desktop'))
    const offer = await screen.findByTestId('desktop-needs-web-chat')
    expect(offer).toHaveTextContent('A desktop app opens Support\'s web chat, and Support has none yet.')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(agentChannelsApi.add).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Add the web chat and the desktop app' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/agents/agent-1/channels/c-desk'))
    expect(vi.mocked(agentChannelsApi.add).mock.calls.map((c) => c[1])).toEqual([{ type: 'web' }, { type: 'desktop' }])
  })

  it('adds a desktop app straight away when the agent has a web chat', async () => {
    vi.mocked(agentChannelsApi.add).mockReset()
    vi.mocked(agentChannelsApi.list).mockResolvedValue([{ id: 'c-web', type: 'web' }] as any)
    vi.mocked(agentChannelsApi.add).mockResolvedValue({ id: 'c-desk', type: 'desktop', name: 'Desktop app' } as any)
    const router = open()
    await screen.findByRole('heading', { name: 'Add channel' })
    await waitFor(() => expect(agentChannelsApi.list).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 0))
    fireEvent.click(screen.getByTestId('channel-desktop'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/agents/agent-1/channels/c-desk'))
    expect(vi.mocked(agentChannelsApi.add).mock.calls.map((c) => c[1])).toEqual([{ type: 'desktop' }])
    expect(screen.queryByTestId('desktop-needs-web-chat')).toBeNull()
  })

  it('cancels the offer without adding anything', async () => {
    vi.mocked(agentChannelsApi.add).mockReset()
    vi.mocked(agentChannelsApi.list).mockResolvedValue([])
    open()
    await waitFor(() => expect(agentChannelsApi.list).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 0))
    fireEvent.click(await screen.findByTestId('channel-desktop'))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('desktop-needs-web-chat')).toBeNull()
    expect(agentChannelsApi.add).not.toHaveBeenCalled()
  })

  // iMessage has no public API, so it is reached through a relay. Both
  // relays are offered, as two tiles that read "iMessage" with the relay
  // underneath, and the one picked is the channel's type.
  it.each([
    ['imessage_sendblue', 'Via Sendblue'],
    ['imessage_loopmessage', 'Via LoopMessage'],
  ] as const)('offers iMessage %s and adds that relay when picked', async (type, hint) => {
    vi.mocked(agentChannelsApi.add).mockReset()
    vi.mocked(agentChannelsApi.list).mockResolvedValue([])
    vi.mocked(agentChannelsApi.add).mockResolvedValue({ id: 'c-imsg', type, name: 'iMessage' } as any)
    const router = open()
    const tile = await screen.findByTestId(`channel-${type}`)
    expect(tile).toHaveTextContent('iMessage')
    expect(tile).toHaveTextContent(hint)

    fireEvent.click(tile)
    await waitFor(() => expect(agentChannelsApi.add).toHaveBeenCalledWith('agent-1', { type }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/agents/agent-1/channels/c-imsg'))
  })
})
