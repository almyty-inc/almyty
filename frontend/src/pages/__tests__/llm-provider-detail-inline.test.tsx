import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'

import { LlmProviderDetailPage } from '../llm-provider-detail'
import { llmProvidersApi } from '@/lib/api'

// The global setup stubs the router hooks; these tests follow real URLs.
vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))
vi.mock('@/lib/api', () => ({
  llmProvidersApi: {
    getById: vi.fn(),
    getUsage: vi.fn(async () => null),
    update: vi.fn(async () => ({})),
    test: vi.fn(),
    chat: vi.fn(),
  },
}))
vi.mock('@/store/app', () => ({
  useNotifications: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}))
// The picker has its own tests; here it only has to hand back a model.
vi.mock('@/components/model-picker', () => ({
  ModelPicker: ({ value, onChange, modelLabel }: any) => (
    <label>
      {modelLabel}
      <input value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value })} />
    </label>
  ),
}))
vi.mock('@/components/connections/connect-sheet', () => ({ ConnectAccountButton: () => null }))
vi.mock('@/components/connections/connection-select', () => ({ ConnectionSelect: () => null }))

const provider = {
  id: 'p-1',
  name: 'OpenAI prod',
  type: 'openai',
  status: 'active',
  totalRequests: 0,
  configuration: { model: 'gpt-4o', maxTokens: 4096, temperature: 0.7, apiKey: '***masked***' },
  capabilities: {},
  createdAt: '2026-01-01T00:00:00.000Z',
}

function renderAt(url: string) {
  const router = createMemoryRouter(
    [
      { path: '/llm-providers/:id', element: <LlmProviderDetailPage /> },
      { path: '/llm-providers/:id/edit', element: <p>edit page</p> },
    ],
    { initialEntries: [url] },
  )
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

describe('inference provider page: edit on its page, test in place', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(llmProvidersApi.getById).mockResolvedValue(provider as any)
  })

  it('Edit opens the provider\'s edit page (where visibility lives), not a dialog', async () => {
    const router = renderAt('/llm-providers/p-1?tab=configuration')
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/llm-providers/p-1/edit'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(llmProvidersApi.update).not.toHaveBeenCalled()
  })

  it('an old ?edit=1 link goes to the edit page', async () => {
    const router = renderAt('/llm-providers/p-1?tab=configuration&edit=1')
    await waitFor(() => expect(router.state.location.pathname).toBe('/llm-providers/p-1/edit'))
  })

  it('?test=1 runs the connection test and shows the answer on the page', async () => {
    vi.mocked(llmProvidersApi.test).mockResolvedValue({ isHealthy: false, error: 'Invalid API key' } as any)
    const router = renderAt('/llm-providers/p-1?test=1')
    const result = await screen.findByTestId('provider-test-result')
    expect(result).toHaveTextContent('Connection failed: Invalid API key')
    expect(llmProvidersApi.test).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(router.state.location.search).toBe(''))
  })

  it('Test connection in the header reports success inline', async () => {
    vi.mocked(llmProvidersApi.test).mockResolvedValue({ isHealthy: true, responseTime: 212 } as any)
    renderAt('/llm-providers/p-1')
    fireEvent.click(await screen.findByRole('button', { name: 'Test connection' }))
    expect(await screen.findByTestId('provider-test-result')).toHaveTextContent('answered in 212 ms')
  })
})
