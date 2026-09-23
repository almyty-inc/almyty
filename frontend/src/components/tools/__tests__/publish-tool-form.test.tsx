import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'

// The form is a page: it needs the real router to leave it.
vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))

const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
vi.mock('@/store/app', () => ({ useNotifications: () => notify }))
vi.mock('@/store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'org-1' } }),
}))

vi.mock('@/lib/api', () => ({
  toolHubApi: {
    publishTemplate: vi.fn(),
    updateTemplate: vi.fn(),
    deleteTemplate: vi.fn(),
  },
  toolsApi: { getById: vi.fn() },
}))

import { toolHubApi, toolsApi } from '@/lib/api'
import { PublishToolForm, isPublishable } from '../publish-tool-form'
import { ToolPublishPage } from '@/pages/tool-publish'

const httpTool = {
  id: 'tool-1',
  name: 'List widgets',
  description: 'List every widget',
  executionMethod: 'http',
  metadata: { sourceApi: { name: 'Acme API' } },
}

function renderAt(element: React.ReactElement, url = '/tools/tool-1/publish') {
  const router = createMemoryRouter(
    [
      { path: '/tools/:id/publish', element },
      { path: '/tools', element: <p>Tools list</p> },
      { path: '/tools/:id', element: <p>Tool page</p> },
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

/**
 * Publishing is the only way a tool template comes into existence, so the
 * page is pinned on what it sends, what it refuses to send, and what it
 * says when the backend says no.
 */
describe('PublishToolForm (/tools/:id/publish)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('offers publishing for an HTTP tool only', () => {
    expect(isPublishable({ executionMethod: 'http' })).toBe(true)
    // Nothing else round-trips: installTemplate rebuilds a tool from
    // httpConfig alone.
    expect(isPublishable({ executionMethod: 'graphql' })).toBe(false)
    expect(isPublishable({ executionMethod: 'custom' })).toBe(false)
    expect(isPublishable({ executionMethod: 'llm' })).toBe(false)
    expect(isPublishable({ executionMethod: null })).toBe(false)
  })

  it('sends the tool id, category and tags, no organization id, and opens the hub', async () => {
    ;(toolHubApi.publishTemplate as any).mockResolvedValue({ id: 'tpl-1' })
    const router = renderAt(<PublishToolForm tool={httpTool} />)

    expect(screen.getByRole('heading', { name: 'Publish to Tool Hub' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/category/i), { target: { value: 'commerce' } })
    fireEvent.change(screen.getByLabelText(/tags/i), { target: { value: 'widgets, catalog' } })
    fireEvent.click(screen.getByRole('button', { name: /^publish$/i }))

    await waitFor(() => expect(toolHubApi.publishTemplate).toHaveBeenCalled())
    const payload = (toolHubApi.publishTemplate as any).mock.calls[0][0]
    expect(payload).toMatchObject({
      toolId: 'tool-1',
      category: 'commerce',
      provider: 'Acme API',
      tags: ['widgets', 'catalog'],
    })
    // Ownership is the caller's validated org on the server; a body that
    // could name one would be a cross-tenant publish.
    expect(payload).not.toHaveProperty('organizationId')
    await waitFor(() => expect(router.state.location.pathname).toBe('/tools'))
    expect(router.state.location.search).toBe('?tab=hub')
  })

  it('will not publish without a category, and says so on the field', async () => {
    renderAt(<PublishToolForm tool={httpTool} />)
    fireEvent.click(screen.getByRole('button', { name: /^publish$/i }))

    const category = screen.getByLabelText(/category/i)
    await waitFor(() => expect(category).toHaveAttribute('aria-invalid', 'true'))
    await waitFor(() => expect(document.activeElement).toBe(category))
    expect(toolHubApi.publishTemplate).not.toHaveBeenCalled()
  })

  it('shows the backend reason when publishing is refused', async () => {
    ;(toolHubApi.publishTemplate as any).mockRejectedValue({
      response: {
        status: 409,
        data: { message: "Your organization already publishes a template named 'List widgets'." },
      },
    })

    renderAt(<PublishToolForm tool={httpTool} />)
    fireEvent.change(screen.getByLabelText(/category/i), { target: { value: 'commerce' } })
    fireEvent.click(screen.getByRole('button', { name: /^publish$/i }))

    await waitFor(() =>
      expect(notify.error).toHaveBeenCalledWith(
        'Publish failed',
        expect.stringContaining('already publishes'),
      ),
    )
  })

  it('the route loads the tool and refuses a tool that cannot be a template', async () => {
    ;(toolsApi.getById as any).mockResolvedValue({ ...httpTool, executionMethod: 'custom' })
    renderAt(<ToolPublishPage />)
    expect(await screen.findByText(/Only HTTP tools can be published/)).toBeInTheDocument()
    expect(toolsApi.getById).toHaveBeenCalledWith('tool-1', 'org-1')
    expect(screen.queryByRole('button', { name: /^publish$/i })).not.toBeInTheDocument()
  })
})
