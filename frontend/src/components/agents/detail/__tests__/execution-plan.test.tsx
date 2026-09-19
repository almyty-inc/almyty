import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ExecutionPlan } from '../execution-plan'
import { api } from '@/lib/api'

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }))
const setup = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onConfigure = vi.fn()
  render(<QueryClientProvider client={client}><ExecutionPlan agentId="a1" onConfigure={onConfigure}><div>Saved builder graph</div></ExecutionPlan></QueryClientProvider>)
  return { client, onConfigure }
}

describe('ExecutionPlan', () => {
  beforeEach(() => vi.clearAllMocks())
  it('shows the saved graph only when the agent actually runs it', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { data: {} } } as any)
    setup()
    expect(await screen.findByText('Saved builder graph')).toBeInTheDocument()
  })
  it('replaces the unused graph with the selected strategy and role explanation', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { data: { strategyKey: 'single' } } } as any)
    const { onConfigure } = setup()
    expect(await screen.findByText('single')).toBeInTheDocument()
    expect(screen.queryByText('Saved builder graph')).not.toBeInTheDocument()
    expect(screen.getByText(/saved builder graph is not used/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Configure strategy and roles' }))
    expect(onConfigure).toHaveBeenCalledOnce()
  })
  it('does not pretend an orchestrator has already chosen a per-request plan', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { data: { strategyKey: 'panel', orchestrator: { enabled: true, fallbackStrategyKey: 'single' } } } } as any)
    setup()
    expect(await screen.findByText(/orchestrator chooses a strategy per request/)).toHaveTextContent('single')
    expect(screen.queryByText('Saved builder graph')).not.toBeInTheDocument()
  })
  it('does not show the saved graph as a fallback for an unreadable setting', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('offline'))
    setup()
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the execution plan')
    expect(screen.queryByText('Saved builder graph')).not.toBeInTheDocument()
  })
  it('responds to Execution tab settings updates without reloading', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { data: {} } } as any)
    const { client } = setup()
    await screen.findByText('Saved builder graph')
    act(() => client.setQueryData(['agent-execution', 'a1'], { strategyKey: 'cascade' }))
    await waitFor(() => expect(screen.queryByText('Saved builder graph')).not.toBeInTheDocument())
    expect(screen.getByText('cascade')).toBeInTheDocument()
  })
})
