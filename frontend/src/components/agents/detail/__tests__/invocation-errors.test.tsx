import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@/test/setup'
import { agentsApi } from '@/lib/api'
import { InvokeDialog } from '../invoke-dialog'
import { OverviewTab } from '../overview-tab'
import { TestPanel } from '../../builder/test-panel'
import type { Agent } from '@/types'

const notifications = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('@/store/app', () => ({ useNotifications: () => notifications }))
vi.mock('@/lib/api', () => ({ agentsApi: { invoke: vi.fn() } }))
vi.mock('../integration-snippets', () => ({ IntegrationSnippets: () => null }))
vi.mock('../agent-config-panel', () => ({ AgentConfigPanel: () => null }))
vi.mock('@/components/ui/code-editor', () => ({
  CodeEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) =>
    <textarea aria-label="JSON input" value={value} onChange={e => onChange(e.target.value)} />,
}))
vi.mock('@/components/ui/code-block', () => ({ CodeBlock: ({ value }: { value: string }) => <pre>{value}</pre> }))

const agent = { id: 'draft-agent', name: 'QA Draft', mode: 'workflow', status: 'draft', pipeline: { nodes: [], edges: [] } } as unknown as Agent
const wrappedError = Object.assign(new Error('Request failed with status code 400'), {
  response: { status: 400, data: { error: { code: 'BAD_REQUEST', message: 'Agent must be active to invoke' } } },
})

function renderOverview() {
  renderWithProviders(<OverviewTab agent={agent} executions={[]} executionsError={null} versions={[]}
    entityVersions={[]} auditLog={[]} webhookUrl="" setWebhookUrl={vi.fn()} scheduleEnabled={false}
    setScheduleEnabled={vi.fn()} scheduleInterval={60} setScheduleInterval={vi.fn()}
    scheduleInput="{}" setScheduleInput={vi.fn()} />)
}

describe('agent invocation errors', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(agentsApi.invoke).mockRejectedValue(wrappedError)
  })

  it('shows the wrapped backend reason inline and in the Invoke dialog notification', async () => {
    renderWithProviders(<InvokeDialog agent={agent} open onOpenChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Run Agent' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Agent must be active to invoke')
    expect(notifications.error).toHaveBeenCalledWith('Invocation Failed', 'Agent must be active to invoke')
    expect(screen.getByRole('button', { name: 'Run Agent' })).toBeEnabled()
  })

  it('shows the wrapped backend reason in the builder Test panel and clears it on retry', async () => {
    renderWithProviders(<TestPanel agentId={agent.id} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Agent must be active to invoke')
    vi.mocked(agentsApi.invoke).mockResolvedValueOnce({ output: 'Retry succeeded' } as any)
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    expect(await screen.findByText(/Retry succeeded/)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows the wrapped backend reason in Overview Try It', async () => {
    renderOverview()
    const input = screen.getByPlaceholderText('Type a message to test this agent...')
    fireEvent.change(input, { target: { value: 'hello' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByRole('alert')).toHaveTextContent('Agent must be active to invoke')
    expect(input).toHaveValue('hello')
    expect(notifications.error).toHaveBeenCalledWith('Invocation Failed', 'Agent must be active to invoke')
  })

  it('preserves useful local invalid-JSON errors without invoking the API', async () => {
    renderWithProviders(<InvokeDialog agent={agent} open onOpenChange={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('JSON input'), { target: { value: '{' } })
    fireEvent.click(screen.getByRole('button', { name: 'Run Agent' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid JSON input')
    expect(agentsApi.invoke).not.toHaveBeenCalled()
  })

  it('removes a stale successful result when a later invocation fails', async () => {
    vi.mocked(agentsApi.invoke).mockResolvedValueOnce({ output: 'Old result' } as any)
    renderWithProviders(<InvokeDialog agent={agent} open onOpenChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Run Agent' }))
    expect(await screen.findByText(/Old result/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Run Agent' }))
    await waitFor(() => expect(screen.queryByText(/Old result/)).not.toBeInTheDocument())
    expect(await screen.findByRole('alert')).toHaveTextContent('Agent must be active to invoke')
  })
})
