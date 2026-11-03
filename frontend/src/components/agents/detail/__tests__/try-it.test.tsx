/**
 * Try it on an agent's Overview. It was a one-line input whose question
 * vanished once the answer came, and the answer was cut off at 320px.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { renderWithProviders } from '@/test/setup'
import { agentsApi } from '@/lib/api'
import { OverviewTab, isLongAnswer } from '../overview-tab'
import type { Agent } from '@/types'

vi.mock('@/store/app', () => ({ useNotifications: () => ({ success: vi.fn(), error: vi.fn() }) }))
vi.mock('@/lib/api', () => ({ agentsApi: { invoke: vi.fn() } }))
vi.mock('../integration-snippets', () => ({ IntegrationSnippets: () => null }))
vi.mock('../agent-config-panel', () => ({ AgentConfigPanel: () => null }))

const agent = { id: 'a-1', name: 'Docs helper', mode: 'workflow', status: 'active', pipeline: { nodes: [], edges: [] } } as unknown as Agent

function renderOverview() {
  renderWithProviders(<OverviewTab agent={agent} executions={[]} executionsError={null} versions={[]}
    entityVersions={[]} auditLog={[]} webhookUrl="" setWebhookUrl={vi.fn()} />)
  return screen.getByRole('textbox', { name: 'Message' })
}

describe('Try it', () => {
  beforeEach(() => vi.clearAllMocks())

  it('is a multi-line box: Shift+Enter is a new line, Enter sends', async () => {
    vi.mocked(agentsApi.invoke).mockResolvedValue({ status: 'completed', output: 'Done.' } as any)
    const box = renderOverview()
    expect(box.tagName).toBe('TEXTAREA')
    fireEvent.change(box, { target: { value: 'Find the discount files' } })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    expect(agentsApi.invoke).not.toHaveBeenCalled()
    fireEvent.change(box, { target: { value: 'Find the discount files\nin the Sales folder' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(await screen.findByText('Done.')).toBeInTheDocument()
    expect(agentsApi.invoke).toHaveBeenCalledWith('a-1', { message: 'Find the discount files\nin the Sales folder' })
  })

  it('keeps the question above the answer after the box clears', async () => {
    vi.mocked(agentsApi.invoke).mockResolvedValue({ status: 'completed', output: 'Three files mention a discount.' } as any)
    const box = renderOverview()
    fireEvent.change(box, { target: { value: 'Which files mention a discount?' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    const answer = await screen.findByTestId('try-it-answer')
    expect(box).toHaveValue('')
    const question = screen.getByTestId('try-it-question')
    expect(question).toHaveTextContent('Which files mention a discount?')
    expect(question.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('does not cut a long answer at 320px, and offers to show all of it', async () => {
    const long = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}`).join('\n\n')
    vi.mocked(agentsApi.invoke).mockResolvedValue({ status: 'completed', output: long } as any)
    const box = renderOverview()
    fireEvent.change(box, { target: { value: 'List everything' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    const answer = await screen.findByTestId('try-it-answer')
    expect(answer.className).not.toContain('max-h-[320px]')
    expect(answer.className).toContain('max-h-[60vh]')
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }))
    expect(answer.className).not.toContain('max-h-')
    expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument()
  })

  it('offers Show all only for a long answer', () => {
    expect(isLongAnswer('Short.')).toBe(false)
    expect(isLongAnswer('x'.repeat(2000))).toBe(true)
    expect(isLongAnswer(Array.from({ length: 30 }, () => 'a').join('\n'))).toBe(true)
  })
})
