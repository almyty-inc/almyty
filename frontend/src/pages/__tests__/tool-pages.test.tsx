import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'

import { ToolNewPage } from '@/pages/tool-new'
import { ToolsPage } from '@/pages/tools'
import { toolsApi } from '@/lib/api'

// Pages and links: the real router, not setup.tsx's stubs.
vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))

// CodeMirror needs a real layout engine; a textarea stands in for it.
vi.mock('@uiw/react-codemirror', () => ({
  default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="code editor" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}))

vi.mock('@/lib/api', () => ({
  toolsApi: { create: vi.fn(), getAll: vi.fn(), delete: vi.fn(), activate: vi.fn() },
  apisApi: { getAll: vi.fn().mockResolvedValue([]), getSdkMaps: vi.fn() },
  organizationsApi: { getTeams: vi.fn().mockResolvedValue([]) },
  credentialsApi: { getAll: vi.fn().mockResolvedValue([]) },
  llmProvidersApi: { getAll: vi.fn().mockResolvedValue([]) },
  modelsApi: { list: vi.fn().mockResolvedValue([]) },
  mcpSourcesApi: { list: vi.fn().mockResolvedValue([]) },
  toolHubApi: {
    getProviders: vi.fn().mockResolvedValue([]),
    getTemplates: vi.fn().mockResolvedValue({ templates: [], total: 0 }),
    getCategories: vi.fn().mockResolvedValue([]),
  },
}))

const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
vi.mock('@/store/app', () => ({ useNotifications: () => notify }))
vi.mock('@/store/organization', () => {
  const state = { currentOrganization: { id: 'org-1' } }
  const hook = (sel?: (s: typeof state) => unknown) => (typeof sel === 'function' ? sel(state) : state)
  hook.getState = () => state
  return { useOrganizationStore: hook }
})

function renderAt(url: string) {
  const router = createMemoryRouter(
    [
      { path: '/tools', element: <ToolsPage /> },
      { path: '/tools/new', element: <ToolNewPage /> },
      { path: '/tools/mcp-servers/new', element: <p>MCP server page</p> },
      { path: '/tools/:id', element: <p>Tool page</p> },
      { path: '/apis/new', element: <p>Connect API page</p> },
    ],
    { initialEntries: [url] },
  )
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(toolsApi.getAll).mockResolvedValue({ tools: [], total: 0 } as any)
})

describe('/tools/new', () => {
  it('is a page with one submit, and the execution method lives in the URL', async () => {
    const router = renderAt('/tools/new?type=custom')
    expect(await screen.findByRole('heading', { name: 'Create tool' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'JavaScript code' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create tool' })).toHaveAttribute('type', 'submit')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(router.state.location.search).toBe('?type=custom')
  })

  it('the model prompt form uses the shared model picker', async () => {
    renderAt('/tools/new?type=llm')
    expect(await screen.findByRole('heading', { name: 'Model' })).toBeInTheDocument()
    expect(screen.getByLabelText('System prompt (optional)')).toBeInTheDocument()
    expect(screen.getByLabelText('Prompt template')).toBeInTheDocument()
  })

  it('creates an HTTP tool with its headers and opens the tool', async () => {
    vi.mocked(toolsApi.create).mockResolvedValue({ id: 'tool-9' } as any)
    const user = userEvent.setup()
    const router = renderAt('/tools/new')
    await user.type(await screen.findByLabelText(/Tool name/), 'list_orders')
    await user.type(screen.getByLabelText('URL'), 'https://api.example.com/orders')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    await user.type(screen.getByLabelText('Header 1 name'), 'X-Tenant')
    await user.type(screen.getByLabelText('Header 1 value'), 'acme')
    await user.click(screen.getByRole('button', { name: 'Create tool' }))

    await waitFor(() => expect(toolsApi.create).toHaveBeenCalled())
    const [payload, orgId] = vi.mocked(toolsApi.create).mock.calls[0] as [any, string]
    expect(orgId).toBe('org-1')
    expect(payload).toMatchObject({
      name: 'list_orders',
      type: 'query',
      executionMethod: 'http',
      visibility: 'org',
      teamId: null,
      httpConfig: {
        method: 'GET',
        path: 'https://api.example.com/orders',
        headers: { 'X-Tenant': 'acme' },
      },
    })
    expect(payload).not.toHaveProperty('code')
    await waitFor(() => expect(router.state.location.pathname).toBe('/tools/tool-9'))
  })

  it('a missing name is reported on the field and focuses it', async () => {
    renderAt('/tools/new')
    fireEvent.click(await screen.findByRole('button', { name: 'Create tool' }))
    const name = screen.getByLabelText(/Tool name/)
    await waitFor(() => expect(name).toHaveAttribute('aria-invalid', 'true'))
    await waitFor(() => expect(document.activeElement).toBe(name))
    expect(toolsApi.create).not.toHaveBeenCalled()
  })
})

describe('tools page entry points', () => {
  it('Create tool and Add MCP server link to their pages', async () => {
    renderAt('/tools')
    const create = await screen.findAllByRole('link', { name: 'Create tool' })
    for (const link of create) expect(link).toHaveAttribute('href', '/tools/new')
    expect(screen.getByRole('link', { name: /Add MCP server/ })).toHaveAttribute('href', '/tools/mcp-servers/new')
    // The empty state sends new users to the connect-API page, not a dialog.
    expect(await screen.findByRole('link', { name: /Import API/ })).toHaveAttribute('href', '/apis/new')
  })

  it('following Create tool lands on the page', async () => {
    const user = userEvent.setup()
    const router = renderAt('/tools')
    await user.click((await screen.findAllByRole('link', { name: 'Create tool' }))[0])
    await waitFor(() => expect(router.state.location.pathname).toBe('/tools/new'))
  })

  it('an old ?new=1 link redirects to /tools/new', async () => {
    const router = renderAt('/tools?new=1')
    await waitFor(() => expect(router.state.location.pathname).toBe('/tools/new'))
  })
})
