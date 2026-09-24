import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'

import { AgentImportPage } from '../agent-import'
import { externalAgentsApi, credentialsApi } from '@/lib/api'

// The global setup stubs useNavigate; this page is about where it goes.
vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))
vi.mock('@/lib/api', () => ({
  agentsApi: { importAgent: vi.fn() },
  externalAgentsApi: { preview: vi.fn(), create: vi.fn() },
  credentialsApi: { getAll: vi.fn() },
}))
const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
vi.mock('@/store/app', () => ({ useNotifications: () => notify }))

const CARD_URL = 'https://remote.example/.well-known/agent.json'
const card = {
  name: 'Remote researcher',
  description: 'Finds papers',
  version: '1.2.0',
  capabilities: { streaming: true, pushNotifications: false },
  skills: [{ id: 'search', name: 'Paper search' }, { id: 'summarize' }],
}

function renderAt(path = '/agents/import?source=a2a') {
  const router = createMemoryRouter(
    [
      { path: '/agents/import', element: <AgentImportPage /> },
      { path: '/agents', element: <p>Agents list</p> },
    ],
    { initialEntries: ['/agents', path], initialIndex: 1 },
  )
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

async function fetchCard() {
  fireEvent.change(screen.getByLabelText('Agent card URL'), { target: { value: CARD_URL } })
  fireEvent.click(screen.getByRole('button', { name: 'Fetch agent card' }))
  await screen.findByTestId('a2a-preview')
}

describe('/agents/import?source=a2a', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(credentialsApi.getAll).mockResolvedValue({
      credentials: [{ id: 'cred-1', name: 'Remote token', type: 'bearer' }],
    })
    Element.prototype.hasPointerCapture ??= vi.fn().mockReturnValue(false)
    Element.prototype.setPointerCapture ??= vi.fn()
    Element.prototype.releasePointerCapture ??= vi.fn()
    Element.prototype.scrollIntoView ??= vi.fn()
  })

  it('is a page, not a dialog, and the JSON import stays the default source', () => {
    renderAt()
    expect(screen.getByRole('heading', { name: 'Import external A2A agent' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Agent JSON')).not.toBeInTheDocument()
  })

  it('falls back to the JSON import for an unknown source', () => {
    renderAt('/agents/import?source=nope')
    expect(screen.getByRole('heading', { name: 'Import agent' })).toBeInTheDocument()
    expect(screen.getByLabelText('Agent JSON')).toBeInTheDocument()
  })

  it('rejects a malformed URL inline and fetches nothing', async () => {
    renderAt()
    fireEvent.change(screen.getByLabelText('Agent card URL'), { target: { value: 'not a url' } })
    fireEvent.click(screen.getByRole('button', { name: 'Fetch agent card' }))
    expect(await screen.findByText(/Enter the full URL/)).toBeInTheDocument()
    expect(screen.getByLabelText('Agent card URL')).toHaveAttribute('aria-invalid', 'true')
    expect(externalAgentsApi.preview).not.toHaveBeenCalled()
  })

  it('previews the card, then imports it without a credential and returns to the list', async () => {
    vi.mocked(externalAgentsApi.preview).mockResolvedValue(card)
    vi.mocked(externalAgentsApi.create).mockResolvedValue({ id: 'ext-1' })
    const router = renderAt()

    await fetchCard()
    expect(externalAgentsApi.preview).toHaveBeenCalledWith(CARD_URL)
    expect(screen.getByText('Remote researcher')).toBeInTheDocument()
    expect(screen.getByText('Finds papers')).toBeInTheDocument()
    expect(screen.getByText('1.2.0')).toBeInTheDocument()
    expect(screen.getByText('streaming, pushNotifications')).toBeInTheDocument()
    expect(screen.getByText('Paper search, summarize')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Import agent' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/agents'))
    // "No authentication" must not reach the API as a credential id.
    expect(externalAgentsApi.create).toHaveBeenCalledWith({
      agentCardUrl: CARD_URL,
      credentialId: undefined,
    })
    expect(notify.success).toHaveBeenCalledWith('Agent imported', expect.any(String))
    expect(screen.queryByText('Discard unsaved changes?')).not.toBeInTheDocument()
  })

  it('sends the chosen credential with the import', async () => {
    vi.mocked(externalAgentsApi.preview).mockResolvedValue(card)
    vi.mocked(externalAgentsApi.create).mockResolvedValue({ id: 'ext-1' })
    const user = userEvent.setup()
    renderAt()

    await fetchCard()
    await user.click(screen.getByLabelText('Credential (optional)'))
    await user.click(await screen.findByRole('option', { name: 'Remote token (bearer)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Import agent' }))

    await waitFor(() =>
      expect(externalAgentsApi.create).toHaveBeenCalledWith({
        agentCardUrl: CARD_URL,
        credentialId: 'cred-1',
      }),
    )
  })

  it('drops the preview when the URL changes, so a different card is never imported', async () => {
    vi.mocked(externalAgentsApi.preview).mockResolvedValue(card)
    renderAt()

    await fetchCard()
    fireEvent.change(screen.getByLabelText('Agent card URL'), {
      target: { value: 'https://other.example/agent.json' },
    })
    expect(screen.queryByTestId('a2a-preview')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Import agent' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Fetch agent card' })).toBeInTheDocument()
  })

  it('shows a failed preview on the field and notifies', async () => {
    vi.mocked(externalAgentsApi.preview).mockRejectedValue(new Error('Agent card not found'))
    renderAt()

    fireEvent.change(screen.getByLabelText('Agent card URL'), { target: { value: CARD_URL } })
    fireEvent.click(screen.getByRole('button', { name: 'Fetch agent card' }))

    expect(await screen.findByText('Agent card not found')).toBeInTheDocument()
    expect(notify.error).toHaveBeenCalledWith('Preview failed', 'Agent card not found')
    expect(screen.queryByTestId('a2a-preview')).not.toBeInTheDocument()
  })

  it('stays on the page and notifies when the import fails', async () => {
    vi.mocked(externalAgentsApi.preview).mockResolvedValue(card)
    vi.mocked(externalAgentsApi.create).mockRejectedValue(new Error('Already imported'))
    const router = renderAt()

    await fetchCard()
    fireEvent.click(screen.getByRole('button', { name: 'Import agent' }))

    await waitFor(() =>
      expect(notify.error).toHaveBeenCalledWith('Import failed', 'Already imported'),
    )
    expect(router.state.location.pathname).toBe('/agents/import')
  })

  it('asks before discarding a typed URL on Cancel', async () => {
    const router = renderAt()
    fireEvent.change(screen.getByLabelText('Agent card URL'), { target: { value: CARD_URL } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByText('Discard unsaved changes?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/agents'))
  })
})
