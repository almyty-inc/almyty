import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'fs'
import { join } from 'path'

import { render } from '../../../test/setup'
import { ExecutionTab } from '../execution-tab'
import { api } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  // The autonomous summary names providers and agents; the workflow tab reads neither.
  llmProvidersApi: { getAll: vi.fn().mockResolvedValue([{ id: 'prov-1', name: 'OpenAI', type: 'openai' }]) },
  agentsApi: { getAll: vi.fn().mockResolvedValue([{ id: 'a1', name: 'This one' }, { id: 'critic', name: 'Critic' }]) },
}))

/**
 * The Execution tab, driven the way a person drives it.
 *
 * This file exists because the tab shipped with the strategy and the
 * orchestrator in component state: choosing either looked like it saved
 * and was forgotten on leaving the tab, and a fresh agent had no way to
 * create its first role, so every strategy stayed disabled for want of
 * slots. The component tests at the time all passed -- they rendered the
 * pieces with props and never asked whether a choice reached the server.
 */
const strategies = [
  { key: 'single', displayName: 'Single call', description: 'One call.', roleSlots: ['principal'], steps: 1, costBand: 'low' as const, latencyBand: 'low' as const, builtIn: true },
  { key: 'cascade', displayName: 'Cascade', description: 'Cheap first.', roleSlots: ['drafter', 'verifier', 'principal'], steps: 3, costBand: 'medium' as const, latencyBand: 'medium' as const, builtIn: true },
]

// A row as GET actually returns it, entity columns and all. The thin
// fixture this replaced is why a toggle that posts the whole row back
// passed here and 400'd against the real validation pipe.
const role = (key: string) => ({
  id: `role-${key}`,
  organizationId: 'org-1',
  agentId: 'a1',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
  key,
  displayName: key,
  binding: { mode: 'resolved' as const, policy: {} },
})

function wire({ roles = [] as any[], execution = {} as any } = {}) {
  ;(api.get as any).mockImplementation(async (url: string) => {
    if (url.endsWith('/roles')) return { data: { data: roles } }
    if (url === '/strategies') return { data: { data: strategies } }
    if (url.endsWith('/execution')) return { data: { data: execution } }
    throw new Error(`unexpected GET ${url}`)
  })
  ;(api.put as any).mockResolvedValue({ data: { data: execution } })
  ;(api.post as any).mockImplementation(async (url: string) =>
    url.endsWith('/resolve') ? { data: { data: [] } } : { data: { data: {} } },
  )
  ;(api.delete as any).mockResolvedValue({ data: { success: true } })
}

const navigate = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return { ...actual, useNavigate: () => navigate }
})

describe('the Execution tab saves what you choose', () => {
  beforeEach(() => vi.clearAllMocks())

  it('sends the chosen strategy to the server instead of keeping it in the page', async () => {
    wire({ roles: [role('principal')] })
    render(<ExecutionTab agentId="a1" />)

    fireEvent.click(await screen.findByTestId('strategy-single'))

    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith('/agents/a1/execution', { strategyKey: 'single' }),
    )
  })

  it('shows the strategy the server already has, so a reload is not a reset', async () => {
    wire({ roles: [role('principal')], execution: { strategyKey: 'cascade' } })
    render(<ExecutionTab agentId="a1" />)

    await waitFor(() => expect(screen.getByTestId('strategy-cascade')).toHaveAttribute('aria-checked', 'true'))
    expect(screen.getByTestId('strategy-single')).toHaveAttribute('aria-checked', 'false')
  })

  it('saves the orchestrator when it is switched on', async () => {
    wire({ roles: [role('principal')] })
    render(<ExecutionTab agentId="a1" />)

    // The switch is disabled until the current settings have loaded --
    // toggling before we know the value would save a guess. A click while
    // disabled does nothing at all, so wait for it rather than racing it.
    const toggle = await screen.findByLabelText('Let a model choose the strategy')
    await waitFor(() => expect(toggle).toBeEnabled())
    fireEvent.click(toggle)

    await waitFor(() => expect(api.put).toHaveBeenCalled())
    const [, body] = (api.put as any).mock.calls[0]
    expect(body.orchestrator.enabled).toBe(true)
  })

  it('offers a way to make the first role, without which every strategy is unusable', async () => {
    wire({ roles: [] })
    render(<ExecutionTab agentId="a1" />)

    // Inline in the Roles card, not a dialog over it.
    expect(screen.queryByTestId('add-role-form')).not.toBeInTheDocument()
    fireEvent.click(await screen.findByTestId('add-role'))
    const form = await screen.findByTestId('add-role-form')
    expect(document.querySelector('[role="dialog"]')).toBeNull()

    // Offered from the slots the shapes actually ask for, rather than
    // left as free text nobody can guess right.
    fireEvent.click(within(form).getByTestId('suggest-principal'))
    fireEvent.click(within(form).getByRole('button', { name: 'Add role' }))

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/agents/a1/roles', {
        key: 'principal',
        displayName: 'principal',
        binding: { mode: 'resolved', policy: { objective: 'cheapest' } },
      }),
    )
  })

  it('closes the inline form on cancel without posting', async () => {
    wire({ roles: [] })
    render(<ExecutionTab agentId="a1" />)

    fireEvent.click(await screen.findByTestId('add-role'))
    const form = await screen.findByTestId('add-role-form')
    fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByTestId('add-role-form')).not.toBeInTheDocument()
    expect(api.post).not.toHaveBeenCalledWith('/agents/a1/roles', expect.anything())
  })

  it('refuses a duplicate key before it reaches the server', async () => {
    wire({ roles: [role('principal')] })
    render(<ExecutionTab agentId="a1" />)

    fireEvent.click(await screen.findByTestId('add-role'))
    const form = await screen.findByTestId('add-role-form')
    fireEvent.change(within(form).getByLabelText(/^Key/), { target: { value: 'principal' } })

    expect(screen.getByTestId('role-key-duplicate')).toBeInTheDocument()
    expect(within(form).getByRole('button', { name: 'Add role' })).toBeDisabled()
  })

  /**
   * An autonomous agent runs its loop on its own models: roles and a
   * strategy, set on its edit page. The tab shows that shape read-only,
   * and none of the workflow controls, which act on a graph it has not got.
   */
  it('shows an autonomous agent its roles and strategy, with a way to edit them', async () => {
    wire({ roles: [role('principal')] })
    render(
      <ExecutionTab
        agentId="a1"
        mode="autonomous"
        models={{
          strategy: 'cascade',
          roles: [
            { key: 'main', name: 'Main', purpose: 'main', kind: 'model', providerId: 'prov-1', model: 'gpt-4o' },
            { key: 'drafter', name: 'Cheap drafts', purpose: 'drafter', kind: 'model', routing: { objective: 'cheapest' } },
            { key: 'checker', name: 'Checker', purpose: 'checker', kind: 'model', providerId: 'prov-1', model: 'gpt-4o-mini' },
            { key: 'teammate_1', name: 'Critic', purpose: 'teammate', kind: 'agent', agentId: 'critic' },
            { key: 'panelist_1', name: 'Panelist 1', purpose: 'panelist', kind: 'model', providerId: 'prov-1' },
          ],
        }}
      />,
    )

    const summary = screen.getByTestId('autonomous-models-summary')
    expect(within(summary).getByTestId('summary-strategy')).toHaveTextContent('Cascade')
    expect(summary).toHaveTextContent(/A cheaper model answers first and a checker double-checks it/)
    expect(await within(summary).findByText('OpenAI / gpt-4o')).toBeInTheDocument()
    expect(within(summary).getByTestId('summary-role-drafter')).toHaveTextContent('Cheap drafts')
    expect(within(summary).getByTestId('summary-role-drafter')).toHaveTextContent('Routed by policy (cheapest)')
    expect(await within(summary).findByText('Agent: Critic')).toBeInTheDocument()
    // A panelist is kept on the agent but cascade does not read it.
    expect(within(summary).getByTestId('summary-role-panelist_1')).toHaveTextContent('not used by Cascade')
    expect(within(summary).getByRole('link', { name: /edit models/i })).toHaveAttribute('href', '/agents/a1/edit')

    // The old line that said none of this applied is gone.
    expect(screen.queryByTestId('execution-workflow-only')).not.toBeInTheDocument()
    expect(screen.queryByText(/apply to workflow agents/i)).not.toBeInTheDocument()
    // No workflow controls, and nothing of theirs is fetched.
    expect(screen.queryByTestId('strategy-single')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Let a model choose the strategy')).not.toBeInTheDocument()
    expect(screen.queryByTestId('add-role')).not.toBeInTheDocument()
    expect(api.get).not.toHaveBeenCalled()
  })

  it('reads an autonomous agent saved before models as Single on its one model', async () => {
    render(
      <ExecutionTab agentId="a1" mode="autonomous" models={null} modelConfig={{ providerId: 'prov-1', model: 'gpt-4o' }} />,
    )
    const summary = screen.getByTestId('autonomous-models-summary')
    expect(within(summary).getByTestId('summary-strategy')).toHaveTextContent('Single')
    expect(within(summary).getByTestId('summary-role-main')).toHaveTextContent('Main')
    expect(await within(summary).findByText('OpenAI / gpt-4o')).toBeInTheDocument()
  })

  it('still offers the strategy for a workflow agent', async () => {
    wire({ roles: [role('principal')] })
    render(<ExecutionTab agentId="a1" mode="workflow" />)
    expect(await screen.findByTestId('strategy-single')).toBeInTheDocument()
    expect(screen.queryByTestId('execution-workflow-only')).not.toBeInTheDocument()
  })

  it('says why a save failed rather than looking as though it worked', async () => {
    wire({ roles: [role('principal')] })
    ;(api.put as any).mockRejectedValue({ response: { data: { error: { message: 'No strategy named "cascade"' } } } })
    render(<ExecutionTab agentId="a1" />)

    fireEvent.click(await screen.findByTestId('strategy-cascade'))
    expect(await screen.findByTestId('execution-error')).toHaveTextContent('No strategy named')
  })

  it('shows what to do when a role cannot be filled, not a generic failure', async () => {
    // The common case for a new organization: roles exist, no model does.
    // A generic message here reads as our fault when the fix is one step
    // and theirs.
    wire({ roles: [role('principal')] })
    ;(api.post as any).mockImplementation(async (url: string) => {
      if (url.endsWith('/resolve')) {
        return Promise.reject({
          response: {
            data: {
              code: 'ROLE_UNRESOLVED',
              message: 'Role "principal" could not be filled: no model in the catalog is usable. Add a model to the catalog, or pin this role to one.',
            },
          },
        })
      }
      return { data: { data: {} } }
    })

    render(<ExecutionTab agentId="a1" />)

    const error = await screen.findByTestId('resolve-error')
    expect(error).toHaveTextContent('principal')
    expect(error).toHaveTextContent(/add a model to the catalog/i)
  })

  it('posts only the fields the upsert accepts, never the whole row back', async () => {
    wire({ roles: [role('principal')] })
    render(<ExecutionTab agentId="a1" />)

    await screen.findByTestId('roles-panel')
    fireEvent.click(screen.getByRole('button', { name: /pin a model/i }))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/agents/a1/roles', expect.anything()))
    const [, sent] = (api.post as any).mock.calls.find((c: any[]) => c[0] === '/agents/a1/roles' && c[1]?.binding)
    // Server-managed columns would be refused by the whitelist pipe.
    for (const banned of ['id', 'organizationId', 'agentId', 'createdAt', 'updatedAt']) {
      expect(sent).not.toHaveProperty(banned)
    }
    expect(sent.key).toBe('principal')
  })
})

/**
 * Two controls on this tab were built, styled, and rendered behind
 * optional props the tab never passed, so neither ever appeared: removing
 * a role (the DELETE route existed the whole time) and ejecting a
 * strategy into an editable graph (the compiler existed; the endpoint did
 * not, and now does). A prop that is optional hides its button silently
 * -- nothing fails, the feature is just absent.
 */
describe('the controls that were rendered behind props nobody passed', () => {
  beforeEach(() => vi.clearAllMocks())

  it('removes a role through the endpoint that always existed', async () => {
    wire({ roles: [role('principal')] })
    render(<ExecutionTab agentId="a1" />)

    fireEvent.click(await screen.findByTestId('remove-role-principal'))
    const dialog = await screen.findByRole('alertdialog')
    expect(api.delete).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove role' }))

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/agents/a1/roles/principal'))
  })

  it('says why when a role will not delete, instead of looking removed', async () => {
    wire({ roles: [role('principal')] })
    ;(api.delete as any).mockRejectedValue({ response: { data: { message: 'A strategy still needs it.' } } })
    render(<ExecutionTab agentId="a1" />)

    fireEvent.click(await screen.findByTestId('remove-role-principal'))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove role' }))

    expect(await screen.findByTestId('remove-role-error')).toHaveTextContent('A strategy still needs it')
  })

  it('ejects the chosen strategy and lands in the builder', async () => {
    wire({ roles: [role('principal')], execution: { strategyKey: 'single' } })
    render(<ExecutionTab agentId="a1" />)

    fireEvent.click(await screen.findByTestId('eject-strategy'))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/agents/a1/execution/eject', {}))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/agents/a1/edit'))
  })

  it('does not move you to the builder when the eject was refused', async () => {
    wire({ roles: [role('principal')], execution: { strategyKey: 'single' } })
    ;(api.post as any).mockImplementation(async (url: string) => {
      if (url.endsWith('/resolve')) return { data: { data: [] } }
      if (url.endsWith('/eject')) {
        throw { response: { data: { message: 'This agent already has a graph.' } } }
      }
      return { data: { data: {} } }
    })
    render(<ExecutionTab agentId="a1" />)

    fireEvent.click(await screen.findByTestId('eject-strategy'))

    expect(await screen.findByTestId('eject-error')).toHaveTextContent('already has a graph')
    expect(navigate).not.toHaveBeenCalled()
  })
})

describe('the agent page tells the tab which kind of agent it is', () => {
  // The autonomous branch above is only reached if the page passes the
  // mode. Without it the tab defaults to the workflow controls, which is
  // exactly the silent no-op this guards against.
  it('passes the agent mode into ExecutionTab', () => {
    const page = readFileSync(join(__dirname, '../../../pages/agent-detail.tsx'), 'utf8')
    const uses = page.match(/<ExecutionTab\b[^>]*>/g) ?? []
    expect(uses.length).toBeGreaterThan(0)
    for (const use of uses) expect(use).toMatch(/\bmode=\{/)
  })
})