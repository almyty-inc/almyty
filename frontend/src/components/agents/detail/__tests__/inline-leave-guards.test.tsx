/**
 * The agent page's inline forms ask before a navigation throws away what
 * was typed into them, the way the create pages do. A clean form, a
 * cancelled one and one whose save landed all leave without asking.
 *
 * Each case mounts the component under a real data router (renderAtRoute),
 * so the blocker is the one the app runs, not a stub.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'

import { renderAtRoute } from '@/test/render-at-route'
import { expectLeaveAsks, expectLeavesWithoutAsking } from '@/test/leave-guard'
import { AddRoleForm } from '@/components/agents/add-role-form'
import { MemoryTab } from '../memory-tab'
import { PromoteRunSection } from '../promote-run-section'
import { RunPanel } from '../run-panel'
import { ConstraintsTab } from '../constraints-tab'
import { VerifyConfigEditor } from '../verify-config-editor'
import { OverviewTab } from '../overview-tab'
import { agentConstraintsApi, agentsApi, memoriesApi, promotedSkillsApi } from '@/lib/api'
import type { Agent } from '@/types'

vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))

vi.mock('@/lib/api', () => ({
  agentsApi: { invoke: vi.fn(), update: vi.fn(), rollback: vi.fn(), schedule: vi.fn(), unschedule: vi.fn() },
  memoriesApi: { put: vi.fn() },
  promotedSkillsApi: { promote: vi.fn() },
  agentConstraintsApi: { list: vi.fn(), add: vi.fn(), setActive: vi.fn(), remove: vi.fn() },
  gatewaysApi: { listSurfaces: vi.fn(), getAll: vi.fn(), create: vi.fn(), update: vi.fn() },
  llmProvidersApi: { getAll: vi.fn(), getModels: vi.fn() },
  organizationsApi: { getById: vi.fn() },
  getApiBaseUrl: () => 'https://api.example.com',
}))
vi.mock('@/lib/models-api', () => ({ modelsApi: { list: vi.fn().mockResolvedValue([]) } }))
vi.mock('@/store/app', () => ({
  useNotifications: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}))
vi.mock('@/store/organization', () => ({
  useOrganizationStore: (selector?: (s: any) => unknown) => {
    const state = { currentOrganization: { id: 'org-1', name: 'Acme', slug: 'acme' } }
    return selector ? selector(state) : state
  },
}))
vi.mock('@/components/ui/code-editor', () => ({
  CodeEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="Code" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}))
vi.mock('../integration-snippets', () => ({ IntegrationSnippets: () => null }))
vi.mock('../agent-config-panel', () => ({ AgentConfigPanel: () => null }))
vi.mock('@/components/model-picker', () => ({
  ModelPicker: () => null,
  asProviderList: () => [],
  useProviderList: () => ({ data: [] }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn()
})

const PATH = '/agents/a1'
const at = (el: JSX.Element) => renderAtRoute(el, { path: PATH, paths: ['/elsewhere'] })

describe('add role', () => {
  const form = (onCancel = vi.fn()) => (
    <AddRoleForm existingKeys={[]} onCreate={vi.fn()} onCancel={onCancel} />
  )

  it('asks when a key is typed in', async () => {
    const { router } = at(form())
    fireEvent.change(screen.getByLabelText(/Key/), { target: { value: 'drafter' } })
    await expectLeaveAsks(router)
  })

  it('leaves a clean form, or one just submitted, without asking', async () => {
    const { router } = at(form())
    fireEvent.change(screen.getByLabelText(/Key/), { target: { value: 'drafter' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add role' }))
    await expectLeavesWithoutAsking(router)
  })
})

describe('add memory', () => {
  it('asks while a memory is half written, not before', async () => {
    const { router } = at(<MemoryTab agentId="a1" memories={[]} />)
    fireEvent.click(screen.getAllByRole('button', { name: /Add memory/ })[0])
    fireEvent.change(screen.getByLabelText(/Content/), { target: { value: 'Prefers email' } })
    await expectLeaveAsks(router)
  })

  it('leaves without asking after Cancel', async () => {
    const { router } = at(<MemoryTab agentId="a1" memories={[]} />)
    fireEvent.click(screen.getAllByRole('button', { name: /Add memory/ })[0])
    fireEvent.change(screen.getByLabelText(/Content/), { target: { value: 'Prefers email' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await expectLeavesWithoutAsking(router)
  })

  it('leaves without asking once the memory is saved', async () => {
    vi.mocked(memoriesApi.put).mockResolvedValue({} as any)
    const { router } = at(<MemoryTab agentId="a1" memories={[]} />)
    fireEvent.click(screen.getAllByRole('button', { name: /Add memory/ })[0])
    fireEvent.change(screen.getByLabelText(/Content/), { target: { value: 'Prefers email' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Add memory' }).at(-1)!)
    await waitFor(() => expect(screen.queryByTestId('add-memory-form')).not.toBeInTheDocument())
    await expectLeavesWithoutAsking(router)
  })
})

describe('promote run', () => {
  it('asks while a skill name is typed in', async () => {
    const { router } = at(<PromoteRunSection runId="r1" />)
    fireEvent.click(screen.getByRole('button', { name: /Promote to skill/ }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Quarterly report' } })
    await expectLeaveAsks(router)
  })

  it('leaves an open but empty form without asking', async () => {
    const { router } = at(<PromoteRunSection runId="r1" />)
    fireEvent.click(screen.getByRole('button', { name: /Promote to skill/ }))
    await expectLeavesWithoutAsking(router)
  })

  it('leaves without asking once the run is promoted', async () => {
    vi.mocked(promotedSkillsApi.promote).mockResolvedValue({} as any)
    const { router } = at(<PromoteRunSection runId="r1" />)
    fireEvent.click(screen.getByRole('button', { name: /Promote to skill/ }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Quarterly report' } })
    fireEvent.click(screen.getByRole('button', { name: 'Promote' }))
    await screen.findByRole('button', { name: /Promote to skill/ })
    await expectLeavesWithoutAsking(router)
  })
})

describe('run panel', () => {
  const agent = { id: 'a1', name: 'Support bot' } as Agent

  it('asks when the input was edited and not run', async () => {
    const { router } = at(<RunPanel agent={agent} onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: '{"message":"Hi"}' } })
    await expectLeaveAsks(router)
  })

  it('does not ask for the untouched default input', async () => {
    const { router } = at(<RunPanel agent={agent} onClose={vi.fn()} />)
    await expectLeavesWithoutAsking(router)
  })

  it('does not ask once the edited input has been run', async () => {
    vi.mocked(agentsApi.invoke).mockResolvedValue({ status: 'completed', output: 'ok' } as any)
    const { router } = at(<RunPanel agent={agent} onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: '{"message":"Hi"}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Run agent' }))
    await screen.findByTestId('invoke-output-text')
    await expectLeavesWithoutAsking(router)
  })
})

describe('constraints', () => {
  beforeEach(() => {
    vi.mocked(agentConstraintsApi.list).mockResolvedValue([] as any)
  })

  it('asks while a rule is typed in and not added', async () => {
    const { router } = at(<ConstraintsTab agentId="a1" />)
    fireEvent.change(screen.getByPlaceholderText(/Add a constraint/), { target: { value: 'Never export twice' } })
    await expectLeaveAsks(router)
  })

  it('leaves without asking once the rule is added', async () => {
    vi.mocked(agentConstraintsApi.add).mockResolvedValue({} as any)
    const { router } = at(<ConstraintsTab agentId="a1" />)
    const input = screen.getByPlaceholderText(/Add a constraint/)
    fireEvent.change(input, { target: { value: 'Never export twice' } })
    fireEvent.click(screen.getByRole('button', { name: /Add/ }))
    await waitFor(() => expect(input).toHaveValue(''))
    await expectLeavesWithoutAsking(router)
  })
})

describe('verification settings', () => {
  const agent = { id: 'a1', agentConfig: { verify: { enabled: false } } } as unknown as Agent

  it('asks once a setting is changed, not before', async () => {
    const { router } = at(<VerifyConfigEditor agent={agent} onDone={vi.fn()} />)
    fireEvent.click(screen.getByRole('switch'))
    await expectLeaveAsks(router)
  })

  it('leaves an unchanged editor without asking', async () => {
    const { router } = at(<VerifyConfigEditor agent={agent} onDone={vi.fn()} />)
    await expectLeavesWithoutAsking(router)
  })
})

describe('webhook and schedule on the overview', () => {
  const agent = {
    id: 'a1', name: 'QA', mode: 'workflow', status: 'draft', version: 1,
    totalExecutions: 0, totalCost: 0, pipeline: { nodes: [], edges: [] },
    webhookUrl: 'https://hooks.example.com/saved',
  } as unknown as Agent
  const overview = (webhookUrl: string) => (
    <OverviewTab agent={agent} executions={[]} versions={[]} entityVersions={[]} auditLog={[]}
      webhookUrl={webhookUrl} setWebhookUrl={vi.fn()} scheduleEnabled={false}
      setScheduleEnabled={vi.fn()} scheduleInterval={60} setScheduleInterval={vi.fn()}
      scheduleInput="{}" setScheduleInput={vi.fn()} />
  )

  it('asks while the webhook URL differs from the saved one', async () => {
    const { router } = at(overview('https://hooks.example.com/typed'))
    await expectLeaveAsks(router)
  })

  it('does not ask when the webhook URL is the saved one', async () => {
    const { router } = at(overview('https://hooks.example.com/saved'))
    await expectLeavesWithoutAsking(router)
  })
})
