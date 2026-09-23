/**
 * A brand-new agent must not greet you with red.
 *
 * Opening the builder put a destructive banner on screen before the user had
 * touched anything: in workflow mode the default graph's Model Call node has
 * no provider yet, and in autonomous mode the instructions and the provider
 * are both empty. None of that is a failure -- it is the form, unfilled --
 * and red on first paint is how people learn to ignore red, which costs us
 * the banners that are real.
 *
 * What must not change is the rule. An attempted save with those fields
 * still empty still refuses, still turns the list red, and still says what
 * to do. That is the whole test: when it is red, and that red still means no.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { renderWithProviders } from '@/test/setup'
import { AgentBuilderPage } from '../agent-builder'
import { agentsApi } from '@/lib/api'

const errorNotif = vi.fn()

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return {
    ...actual,
    // No :id -- this is /agents/new.
    useParams: () => ({}),
    useNavigate: () => vi.fn(),
    useSearchParams: () => [new URLSearchParams(), vi.fn()],
  }
})

vi.mock('@/lib/api', () => ({
  agentsApi: {
    getById: vi.fn(),
    getAll: vi.fn().mockResolvedValue([]),
    getTemplates: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({ id: 'agent-1' }),
  },
  llmProvidersApi: { getAll: vi.fn().mockResolvedValue([]) },
  toolsApi: { getAll: vi.fn().mockResolvedValue([]) },
}))

vi.mock('@/store/organization', () => ({
  useOrganizationStore: (selector?: (s: any) => unknown) => {
    const state = { currentOrganization: { id: 'org-1', name: 'Acme' } }
    return selector ? selector(state) : state
  },
}))

vi.mock('@/store/app', () => ({
  useNotifications: () => ({ success: vi.fn(), error: errorNotif }),
}))
vi.mock('@/components/agents/builder/canvas-area', () => ({ CanvasArea: () => null }))
vi.mock('@/components/agents/builder/test-panel', () => ({ TestPanel: () => null }))
vi.mock('@/lib/analytics', () => ({ captureEvent: vi.fn() }))

const saveButton = () => screen.getByRole('button', { name: /save/i })

describe('a new agent draft nobody has touched yet', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows the remaining steps, in no error styling at all', async () => {
    renderWithProviders(<AgentBuilderPage />)

    // The work that is left is on screen -- nothing is being hidden.
    const steps = await screen.findByTestId('builder-next-steps')
    expect(steps).toHaveTextContent(/to finish this agent/i)
    expect(steps).toHaveTextContent(/model call: pick a model/i)

    // But it is not an error: no destructive banner, no alert role, and
    // nothing inside it reaching for the destructive palette.
    expect(screen.queryByTestId('builder-validation-errors')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(steps.className).not.toMatch(/destructive/)
    expect(steps.querySelector('[class*="destructive"]')).toBeNull()
  })

  it('leaves Save live, because pressing it is how the user asks what is left', async () => {
    renderWithProviders(<AgentBuilderPage />)

    await screen.findByTestId('builder-next-steps')
    expect(saveButton()).toBeEnabled()
  })

  it('still refuses the save, and still says what to do', async () => {
    const user = userEvent.setup()
    renderWithProviders(<AgentBuilderPage />)

    await screen.findByTestId('builder-next-steps')
    await user.click(saveButton())

    // Refused: nothing was sent.
    expect(agentsApi.create).not.toHaveBeenCalled()

    // And now it is an error, still phrased as the step that closes it.
    const banner = await screen.findByTestId('builder-validation-errors')
    expect(banner).toHaveTextContent(/model call: pick a model/i)
    expect(screen.queryByTestId('builder-next-steps')).not.toBeInTheDocument()
    expect(saveButton()).toBeDisabled()

    expect(errorNotif).toHaveBeenCalledWith(
      'Not ready to save yet',
      expect.stringMatching(/model call: pick a model/i),
    )
  })

  it('turns red on its own once the user has been in a field and left it empty', async () => {
    const user = userEvent.setup()
    renderWithProviders(<AgentBuilderPage />)

    await screen.findByTestId('builder-next-steps')

    // Clearing the name is the user filling something in, badly, and that is
    // exactly when an error is the honest word for it. No save needed.
    await user.clear(screen.getByDisplayValue('New Agent'))

    const banner = await screen.findByTestId('builder-validation-errors')
    expect(banner).toHaveTextContent(/name the agent/i)
  })
})

describe('a new autonomous draft nobody has touched yet', () => {
  beforeEach(() => vi.clearAllMocks())

  it('asks for instructions and a provider without calling either a failure', async () => {
    const user = userEvent.setup()
    renderWithProviders(<AgentBuilderPage />)

    await screen.findByTestId('builder-next-steps')
    await user.click(screen.getByRole('button', { name: 'Autonomous' }))

    await waitFor(() =>
      expect(screen.getByTestId('builder-next-steps')).toHaveTextContent(
        /write the instructions/i,
      ),
    )
    expect(screen.getByTestId('builder-next-steps')).toHaveTextContent(
      /pick a model/i,
    )

    // Flipping the mode toggle is not filling in a form.
    expect(screen.queryByTestId('builder-validation-errors')).not.toBeInTheDocument()
  })
})
