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

const role = (key: string) => ({ key, displayName: key, binding: { mode: 'resolved' as const, policy: {} } })

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
})
