import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'

import { ToolDetailPage } from '../tool-detail'
import { toolsApi } from '@/lib/api'

// "Test tool" on the tools list links to `?tab=test` here instead of
// opening a dialog, so the tab has to come from the URL.
vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))

vi.mock('@/lib/api', () => ({
  toolsApi: { getById: vi.fn(), activate: vi.fn(), deactivate: vi.fn(), execute: vi.fn() },
  workspacesApi: { getAll: vi.fn() },
}))
vi.mock('@/store/app', () => ({
  useNotifications: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}))
vi.mock('@/store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'org-1' } }),
}))

const TOOL = {
  id: 'tool-1',
  name: 'List widgets',
  status: 'active',
  executionMethod: 'http',
  parameters: {},
}

function renderAt(url: string) {
  const router = createMemoryRouter([{ path: '/tools/:id', element: <ToolDetailPage /> }], {
    initialEntries: [url],
  })
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('tool detail links', () => {
  beforeEach(() => {
    vi.mocked(toolsApi.getById).mockResolvedValue(TOOL as any)
  })

  it('?tab=test opens the test form', async () => {
    renderAt('/tools/tool-1?tab=test')
    expect(await screen.findByText('Execute this tool with parameters')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Test tool' })).toHaveAttribute('aria-selected', 'true')
  })

  it('an HTTP tool links to its publish page', async () => {
    renderAt('/tools/tool-1')
    expect(await screen.findByRole('link', { name: /Publish to hub/ })).toHaveAttribute('href', '/tools/tool-1/publish')
  })

  it('other tools do not offer publishing', async () => {
    vi.mocked(toolsApi.getById).mockResolvedValue({ ...TOOL, executionMethod: 'custom' } as any)
    renderAt('/tools/tool-1')
    await screen.findByRole('heading', { name: 'List widgets' })
    expect(screen.queryByRole('link', { name: /Publish to hub/ })).not.toBeInTheDocument()
  })
})
