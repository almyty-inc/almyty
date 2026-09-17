import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'

import { render } from '../../../test/setup'
import { ExecutionTab } from '../execution-tab'
import { api } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
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
}

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

    fireEvent.click(await screen.findByTestId('add-role'))
    const dialog = await screen.findByTestId('add-role-dialog')
    expect(dialog).toBeInTheDocument()

    // Offered from the slots the shapes actually ask for, rather than
    // left as free text nobody can guess right.
    fireEvent.click(screen.getByTestId('suggest-principal'))
    fireEvent.click(screen.getByTestId('create-role'))

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/agents/a1/roles', {
        key: 'principal',
        displayName: 'principal',
        binding: { mode: 'resolved', policy: { objective: 'cheapest' } },
      }),
    )
  })

  it('refuses a duplicate key before it reaches the server', async () => {
    wire({ roles: [role('principal')] })
    render(<ExecutionTab agentId="a1" />)

    fireEvent.click(await screen.findByTestId('add-role'))
    fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'principal' } })

    expect(screen.getByTestId('role-key-duplicate')).toBeInTheDocument()
    expect(screen.getByTestId('create-role')).toBeDisabled()
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
