import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, fireEvent } from '@testing-library/react'

import { render } from '../../../test/setup'

const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
vi.mock('@/store/app', () => ({ useNotifications: () => notify }))

vi.mock('@/lib/api', () => ({
  toolHubApi: {
    publishTemplate: vi.fn(),
    updateTemplate: vi.fn(),
    deleteTemplate: vi.fn(),
  },
}))

import { toolHubApi } from '@/lib/api'
import { PublishToolDialog, isPublishable } from '../publish-tool-dialog'

const httpTool = {
  id: 'tool-1',
  name: 'List widgets',
  description: 'List every widget',
  executionMethod: 'http',
  metadata: { sourceApi: { name: 'Acme API' } },
}

/**
 * Publishing is the only way a tool template comes into existence, so the
 * dialog is pinned on what it sends, what it refuses to send, and what it
 * says when the backend says no.
 */
describe('PublishToolDialog', () => {
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

  it('sends the tool id, category and tags, and no organization id', async () => {
    ;(toolHubApi.publishTemplate as any).mockResolvedValue({ id: 'tpl-1' })

    render(<PublishToolDialog tool={httpTool} onOpenChange={vi.fn()} />)

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
  })

  it('will not publish without a category', () => {
    render(<PublishToolDialog tool={httpTool} onOpenChange={vi.fn()} />)

    expect(screen.getByRole('button', { name: /^publish$/i })).toBeDisabled()
    expect(toolHubApi.publishTemplate).not.toHaveBeenCalled()
  })

  it('shows the backend reason when publishing is refused', async () => {
    ;(toolHubApi.publishTemplate as any).mockRejectedValue({
      response: {
        status: 409,
        data: { message: "Your organization already publishes a template named 'List widgets'." },
      },
    })

    render(<PublishToolDialog tool={httpTool} onOpenChange={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/category/i), { target: { value: 'commerce' } })
    fireEvent.click(screen.getByRole('button', { name: /^publish$/i }))

    await waitFor(() =>
      expect(notify.error).toHaveBeenCalledWith(
        'Publish failed',
        expect.stringContaining('already publishes'),
      ),
    )
  })
})
