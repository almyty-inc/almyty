/**
 * The Run and Test panels started with {"message": "Hello"} whatever the
 * agent's Input step declared, and Try it sent {message} too: an agent that
 * starts with "invoices" was run with nothing in it. Both now start from the
 * declared fields.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'

import { renderWithProviders } from '@/test/setup'
import { agentsApi } from '@/lib/api'
import { defaultRunInput } from '../run-panel'
import { OverviewTab } from '../overview-tab'
import { TestPanel } from '../../builder/test-panel'
import { messageInput, sampleInput } from '../../step-values'
import type { Agent } from '@/types'

vi.mock('@/store/app', () => ({ useNotifications: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }))
vi.mock('@/lib/api', () => ({ agentsApi: { invoke: vi.fn() } }))
vi.mock('../integration-snippets', () => ({ IntegrationSnippets: () => null }))
vi.mock('../agent-config-panel', () => ({ AgentConfigPanel: () => null }))
vi.mock('@/components/ui/code-editor', () => ({
  CodeEditor: ({ value }: { value?: string }) => <textarea data-testid="code-editor" readOnly value={value || ''} />,
}))

const invoicesSchema = { type: 'object', properties: { invoices: { type: 'string' }, month: { type: 'integer' } } }
const agent = {
  id: 'a-1', name: 'Invoice checker', mode: 'workflow', status: 'active',
  pipeline: { nodes: [{ id: 'input_1', type: 'input', data: { schema: invoicesSchema } }], edges: [] },
} as unknown as Agent

describe('a run starts with the fields the Input step declares', () => {
  beforeEach(() => vi.clearAllMocks())

  it('builds the starting input from the schema, a message when it declares none', () => {
    expect(sampleInput(invoicesSchema)).toEqual({ invoices: '', month: 0 })
    expect(sampleInput(undefined)).toEqual({ message: 'Hello' })
    expect(JSON.parse(defaultRunInput(agent))).toEqual({ invoices: '', month: 0 })
    expect(JSON.parse(defaultRunInput({ ...agent, mode: 'autonomous' } as Agent))).toEqual({ message: 'Hello' })
  })

  it('prefills the builder Test panel from the schema', () => {
    renderWithProviders(<TestPanel agentId="a-1" inputSchema={invoicesSchema} onClose={vi.fn()} />)
    expect(JSON.parse((screen.getByTestId('code-editor') as HTMLTextAreaElement).value)).toEqual({ invoices: '', month: 0 })
  })

  it('puts a typed message in the declared text field', () => {
    expect(messageInput(invoicesSchema, 'INV-1')).toEqual({ invoices: 'INV-1' })
    expect(messageInput(undefined, 'hi')).toEqual({ message: 'hi' })
    expect(messageInput({ properties: { message: {}, other: {} } }, 'hi')).toEqual({ message: 'hi' })
  })

  it('Try it sends the message in the declared field', async () => {
    vi.mocked(agentsApi.invoke).mockResolvedValue({ status: 'completed', output: 'Checked.' } as any)
    renderWithProviders(<OverviewTab agent={agent} executions={[]} executionsError={null} versions={[]}
      entityVersions={[]} auditLog={[]} webhookUrl="" setWebhookUrl={vi.fn()} />)
    const box = screen.getByRole('textbox', { name: 'Message' })
    fireEvent.change(box, { target: { value: 'INV-1, INV-2' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(await screen.findByText('Checked.')).toBeInTheDocument()
    expect(agentsApi.invoke).toHaveBeenCalledWith('a-1', { invoices: 'INV-1, INV-2' })
  })
})
