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
  return { ...actual, agentChannelsApi: { add: vi.fn().mockResolvedValue({ id: 'c-new', type: 'slack' }) } }
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
})
