import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
vi.mock('@/store/app', () => ({ useNotifications: () => notify }))
vi.mock('@/lib/api', () => ({ toolsApi: { update: vi.fn() } }))

import { toolsApi } from '@/lib/api'
import { SideEffectCard, sideEffectReason } from '../side-effect-card'

function renderCard(tool: Record<string, any>) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SideEffectCard tool={{ id: 'tool-1', ...tool }} organizationId="org-1" canEdit />
    </QueryClientProvider>,
  )
}

describe('What a tool does to your data', () => {
  beforeEach(() => {
    vi.mocked(toolsApi.update).mockReset().mockResolvedValue({} as any)
    // Radix Select in jsdom.
    if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn()
  })

  it('says what the tool does and why, in plain words', () => {
    renderCard({ sideEffect: 'destructive', sideEffectSource: 'http_method', metadata: { sourceOperation: { method: 'DELETE' } } })
    expect(screen.getByTestId('side-effect-badge')).toHaveTextContent('Deletes data')
    expect(screen.getByTestId('side-effect-reason')).toHaveTextContent('From its HTTP method, DELETE.')
    expect(screen.getByText('Reaches an outside service')).toBeInTheDocument()
  })

  it.each([
    [{ sideEffectSource: 'override' }, 'Set by a person on this page.'],
    [{ sideEffectSource: 'annotation' }, 'Said by the MCP server the tool comes from.'],
    [{ sideEffectSource: 'graphql', sideEffect: 'read' }, 'It is a GraphQL query.'],
    [{ sideEffectSource: 'graphql', sideEffect: 'write' }, 'It is a GraphQL mutation.'],
    [{ sideEffectSource: 'default', executionMethod: 'llm' }, 'It only asks a model, so it changes nothing.'],
    [{ sideEffectSource: 'default', executionMethod: 'custom' }, 'Nothing about the tool says for sure, so it is treated as changing data.'],
  ])('explains source %j', (tool, reason) => {
    expect(sideEffectReason(tool as any)).toBe(reason)
  })

  it('saves a class a person picks, and Automatic drops it', async () => {
    renderCard({ sideEffect: 'write', sideEffectSource: 'default', executionMethod: 'custom' })
    await userEvent.click(screen.getByLabelText('Set it yourself'))
    await userEvent.click(await screen.findByRole('option', { name: 'Deletes data' }))
    await waitFor(() => expect(toolsApi.update).toHaveBeenCalledWith('tool-1', { sideEffect: 'destructive' }, 'org-1'))
  })

  it('shows an override as selected, and offers Automatic to drop it', async () => {
    renderCard({ sideEffect: 'read', sideEffectSource: 'override' })
    expect(screen.getByLabelText('Set it yourself')).toHaveTextContent('Only reads')
    await userEvent.click(screen.getByLabelText('Set it yourself'))
    await userEvent.click(await screen.findByRole('option', { name: 'Automatic' }))
    await waitFor(() => expect(toolsApi.update).toHaveBeenCalledWith('tool-1', { sideEffect: 'auto' }, 'org-1'))
  })
})
