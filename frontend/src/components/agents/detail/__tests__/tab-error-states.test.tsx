/**
 * Failed-fetch states for the agent detail tabs whose query lives on the page.
 *
 * All three used to render their empty state on a failed read, which is the
 * one thing an empty state must not do: it makes a positive claim ("no runs
 * yet", "no files uploaded yet") the screen has no basis for, and the user
 * acts on it -- re-uploading files that are already there, or re-running an
 * agent that already ran.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'

import { renderWithProviders } from '@/test/setup'
import { OverviewTab } from '../overview-tab'
import { MemoryTab } from '../memory-tab'
import { FilesTab } from '../files-tab'
import type { Agent } from '@/types'

vi.mock('@/lib/api', () => ({
  agentsApi: { invoke: vi.fn(), rollback: vi.fn(), update: vi.fn() },
  memoriesApi: { put: vi.fn() },
  filesApi: { upload: vi.fn(), download: vi.fn() },
}))
vi.mock('@/lib/models-api', () => ({ modelsApi: { list: vi.fn().mockResolvedValue([]) } }))
vi.mock('@/store/app', () => ({ useNotifications: () => ({ success: vi.fn(), error: vi.fn() }) }))
vi.mock('@/store/organization', () => ({
  useOrganizationStore: (selector?: (s: any) => unknown) => {
    const state = { currentOrganization: { id: 'org-1' } }
    return selector ? selector(state) : state
  },
}))
vi.mock('../integration-snippets', () => ({ IntegrationSnippets: () => null }))
vi.mock('../agent-config-panel', () => ({ AgentConfigPanel: () => null }))
vi.mock('@/components/ui/code-editor', () => ({ CodeEditor: () => null }))

const agent = {
  id: 'agent-1', name: 'QA Draft', mode: 'workflow', status: 'draft',
  version: 1, totalExecutions: 0, totalCost: 0,
  pipeline: { nodes: [], edges: [] },
} as unknown as Agent

function renderOverview(executionsError: Error | null, onRetryExecutions?: () => void) {
  renderWithProviders(
    <OverviewTab agent={agent} executions={[]} executionsError={executionsError}
      onRetryExecutions={onRetryExecutions} versions={[]}
      entityVersions={[]} auditLog={[]} webhookUrl="" setWebhookUrl={vi.fn()} scheduleEnabled={false}
      setScheduleEnabled={vi.fn()} scheduleInterval={60} setScheduleInterval={vi.fn()}
      scheduleInput="{}" setScheduleInput={vi.fn()} />,
  )
}

describe('agent detail tabs on a failed fetch', () => {
  it('Overview shows the shared error state for Recent runs instead of "no runs yet"', () => {
    const onRetryExecutions = vi.fn()
    renderOverview(new Error('gateway timeout'), onRetryExecutions)

    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load recent runs")
    expect(screen.getByRole('alert')).toHaveTextContent('gateway timeout')
    expect(screen.queryByText('No runs yet')).not.toBeInTheDocument()
    screen.getByRole('button', { name: /Try again/ }).click()
    expect(onRetryExecutions).toHaveBeenCalled()
  })

  it('Overview shows the empty state with a run action when there is no error', () => {
    renderOverview(null)

    expect(screen.getByText('No runs yet')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Run this agent/ })).toBeInTheDocument()
  })

  it('Memory shows the shared error state, with a retry, instead of "no memories yet"', () => {
    const onRetry = vi.fn()
    renderWithProviders(<MemoryTab agentId="agent-1" memories={[]} error={new Error('nope')} onRetry={onRetry} />)

    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load memories")
    expect(screen.queryByText('No memories yet')).not.toBeInTheDocument()
    screen.getByRole('button', { name: /Try again/ }).click()
    expect(onRetry).toHaveBeenCalled()
  })

  it('Files shows the shared error state instead of "no files uploaded yet"', () => {
    renderWithProviders(<FilesTab agentId="agent-1" files={[]} error={new Error('nope')} />)

    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load files")
    expect(screen.queryByText('No files uploaded yet')).not.toBeInTheDocument()
  })

  it('Files still shows the empty state, with an upload action, when there is no error', () => {
    renderWithProviders(<FilesTab agentId="agent-1" files={[]} />)

    expect(screen.getByText('No files uploaded yet')).toBeInTheDocument()
    // The header and the empty state offer it under the same label.
    expect(screen.getAllByRole('button', { name: /Upload file$/ })).toHaveLength(2)
  })
})
