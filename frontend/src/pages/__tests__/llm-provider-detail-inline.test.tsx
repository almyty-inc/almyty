import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
    [{ path: '/llm-providers/:id', element: <LlmProviderDetailPage /> }],
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

describe('inference provider page: edit and test in place', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(llmProvidersApi.getById).mockResolvedValue(provider as any)
  })

  it('edits on the Configuration tab and saves one PATCH', async () => {
    renderAt('/llm-providers/p-1?tab=configuration')
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const form = screen.getByRole('form', { name: 'Edit provider' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'OpenAI staging' } })
    fireEvent.change(within(form).getByLabelText('Default model'), { target: { value: 'gpt-4.1' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(llmProvidersApi.update).toHaveBeenCalledTimes(1))
    const [id, body] = vi.mocked(llmProvidersApi.update).mock.calls[0]
    expect(id).toBe('p-1')
    expect(body).toMatchObject({ name: 'OpenAI staging', configuration: { model: 'gpt-4.1', maxTokens: 4096 } })
    // A masked key is never sent back as if it were a new one.
    expect(body.configuration.apiKey).toBeUndefined()
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Edit provider' })).not.toBeInTheDocument())
  })

  it('Cancel leaves the stored settings alone', async () => {
    renderAt('/llm-providers/p-1?tab=configuration')
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('form', { name: 'Edit provider' })).not.toBeInTheDocument()
    expect(llmProvidersApi.update).not.toHaveBeenCalled()
  })

  it('the list row menu link ?edit=1 opens the form on the Configuration tab', async () => {
    const router = renderAt('/llm-providers/p-1?tab=configuration&edit=1')
    expect(await screen.findByRole('form', { name: 'Edit provider' })).toBeInTheDocument()
    // The one-shot flag is stripped so a refresh does not reopen it.
    await waitFor(() => expect(router.state.location.search).toBe('?tab=configuration'))
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
