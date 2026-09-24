import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'

import { AgentImportPage, parseAgentExport } from '../agent-import'
import { agentsApi } from '@/lib/api'

// The global setup stubs useNavigate; this page is about where it goes.
vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))
vi.mock('@/lib/api', () => ({ agentsApi: { importAgent: vi.fn() } }))
vi.mock('@/store/app', () => ({
  useNotifications: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}))

function renderAt(path = '/agents/import') {
  const router = createMemoryRouter(
    [
      { path: '/agents/import', element: <AgentImportPage /> },
      { path: '/agents', element: <p>Agents list</p> },
      { path: '/agents/:id/edit', element: <p>Builder</p> },
    ],
    { initialEntries: ['/agents', path], initialIndex: 1 },
  )
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

describe('/agents/import', () => {
  beforeEach(() => vi.clearAllMocks())

  it('is a page with one primary action, not a dialog', () => {
    renderAt()
    expect(screen.getByRole('heading', { name: 'Import agent' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Import agent' })).toHaveLength(1)
  })

  it('imports the pasted JSON and opens the new agent in the builder', async () => {
    vi.mocked(agentsApi.importAgent).mockResolvedValue({ id: 'a-9' })
    const router = renderAt()
    fireEvent.change(screen.getByLabelText('Agent JSON'), {
      target: { value: '{"name":"Copied","pipeline":{"nodes":[],"edges":[]}}' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Import agent' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/agents/a-9/edit'))
    expect(agentsApi.importAgent).toHaveBeenCalledWith({
      name: 'Copied',
      pipeline: { nodes: [], edges: [] },
    })
    // A successful import does not ask "discard changes?" on the way out.
    expect(screen.queryByText('Discard unsaved changes?')).not.toBeInTheDocument()
  })

  it('rejects invalid JSON inline, focuses the field and sends nothing', async () => {
    renderAt()
    const field = screen.getByLabelText('Agent JSON')
    fireEvent.change(field, { target: { value: '{"name": ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Import agent' }))
    expect(await screen.findByText(/isn't valid JSON/)).toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).toBe(field))
    expect(agentsApi.importAgent).not.toHaveBeenCalled()
  })

  it('asks before discarding pasted JSON on Cancel', async () => {
    const router = renderAt()
    fireEvent.change(screen.getByLabelText('Agent JSON'), { target: { value: '{}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByText('Discard unsaved changes?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/agents'))
  })
})

describe('parseAgentExport', () => {
  it('explains each way an export can be wrong', () => {
    expect(parseAgentExport('').error).toMatch(/Choose a file/)
    expect(parseAgentExport('[1]').error).toMatch(/JSON object/)
    expect(parseAgentExport('nope').error).toMatch(/valid JSON/)
    expect(parseAgentExport('{"a":1}')).toEqual({ data: { a: 1 } })
  })
})
