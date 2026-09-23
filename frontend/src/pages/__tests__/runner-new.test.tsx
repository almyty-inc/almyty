import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { render } from '../../test/setup'
import { RunnerNewPage } from '../runner-new'

vi.mock('../../lib/api', () => ({
  runnersApi: { getAll: vi.fn(), getById: vi.fn(), create: vi.fn(), update: vi.fn(), unregister: vi.fn() },
  organizationsApi: { getTeams: vi.fn().mockResolvedValue([]) },
}))
vi.mock('../../store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'o1', name: 'Org' } }),
}))
vi.mock('../../store/auth', () => ({
  useAuthStore: () => ({ user: { id: 'me' } }),
}))

const mockSuccess = vi.fn()
vi.mock('../../store/app', () => ({
  useNotifications: () => ({ success: mockSuccess, error: vi.fn(), info: vi.fn() }),
}))

const mockNavigate = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => mockNavigate }
})

import { runnersApi } from '../../lib/api'
const getAll = runnersApi.getAll as ReturnType<typeof vi.fn>
const getById = runnersApi.getById as ReturnType<typeof vi.fn>
const create = runnersApi.create as ReturnType<typeof vi.fn>
const update = runnersApi.update as ReturnType<typeof vi.fn>
const unregister = runnersApi.unregister as ReturnType<typeof vi.fn>

const pendingRunner = (over: Record<string, unknown> = {}) => ({
  id: 'r-new', name: 'my-laptop', state: 'registered', ownerUserId: 'me',
  visibility: 'private', teamId: null, labels: {}, runtimeInfo: null, lastHeartbeatAt: null,
  ...over,
})

async function generate(user: ReturnType<typeof userEvent.setup>, name = 'my-laptop') {
  await user.type(await screen.findByLabelText(/^name$/i), name)
  await user.click(screen.getByRole('button', { name: /generate command/i }))
  await screen.findByText(/Run these on the target machine/i)
}

describe('RunnerNewPage', () => {
  beforeEach(() => {
    for (const fn of [getAll, getById, create, update, unregister, mockNavigate, mockSuccess]) fn.mockReset()
    getAll.mockResolvedValue([])
    create.mockImplementation(async (body: any) => pendingRunner(body))
    update.mockImplementation(async (_id: string, body: any) => pendingRunner(body))
    getById.mockResolvedValue(pendingRunner())
    unregister.mockResolvedValue({})
  })

  it('offers Private, Team and Org-wide, with Private chosen by default', async () => {
    render(<RunnerNewPage />)
    expect(await screen.findByRole('radio', { name: /private/i })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: /team/i })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('radio', { name: /org-wide/i })).toHaveAttribute('aria-checked', 'false')
  })

  it('rejects names already taken in the organization', async () => {
    getAll.mockResolvedValue([{ id: 'r1', name: 'taken-name', state: 'online', ownerUserId: 'someone', lastHeartbeatAt: new Date().toISOString() }])
    const user = userEvent.setup()
    render(<RunnerNewPage />)
    await user.type(await screen.findByLabelText(/^name$/i), 'taken-name')
    await waitFor(() => {
      expect(screen.getByText(/already exists in this organization/i)).toBeInTheDocument()
    })
  })

  it('rejects invalid name characters via zod regex', async () => {
    const user = userEvent.setup()
    render(<RunnerNewPage />)
    await user.type(await screen.findByLabelText(/^name$/i), 'has spaces')
    await user.click(screen.getByRole('button', { name: /generate command/i }))
    await waitFor(() => {
      expect(screen.getByText(/letters, numbers/i)).toBeInTheDocument()
    })
    expect(create).not.toHaveBeenCalled()
  })

  it('creates the runner record with name, labels and visibility, and shows one install path', async () => {
    const user = userEvent.setup()
    render(<RunnerNewPage />)
    expect(screen.getByText(/labels do not affect where work is dispatched yet/i)).toBeInTheDocument()
    await user.type(await screen.findByLabelText(/^name$/i), 'my-laptop')
    await user.click(screen.getByRole('button', { name: /add label/i }))
    await user.type(screen.getByPlaceholderText('key'), 'env')
    await user.type(screen.getByPlaceholderText('value'), 'dev')
    await user.click(screen.getByRole('button', { name: /generate command/i }))

    await screen.findByText(/Run these on the target machine/i)
    expect(create).toHaveBeenCalledWith({ name: 'my-laptop', labels: { env: 'dev' }, visibility: 'private', teamId: null })
    // One coherent path: global install once, then the installed binaries.
    expect(screen.getByText('npm i -g @almyty/runner @almyty/auth')).toBeInTheDocument()
    expect(screen.getAllByText('almyty-auth login').length).toBeGreaterThan(0)
    expect(screen.getByText('almyty-runner start --name my-laptop --org o1')).toBeInTheDocument()
    expect(screen.queryByText(/npx/)).toBeNull()
    // Visibility is on the server record, not a flag the CLI never accepted.
    expect(screen.queryByText(/--team-id/)).toBeNull()
  })

  it('says in one sentence what identifies and authorises the runner', async () => {
    const user = userEvent.setup()
    render(<RunnerNewPage />)
    await generate(user)
    expect(screen.getByTestId('runner-identity')).toHaveTextContent(
      /identified and authorised by your almyty login on that machine, not by its name/i,
    )
  })

  it('goes back to step 1 and updates the same record instead of creating another', async () => {
    const user = userEvent.setup()
    render(<RunnerNewPage />)
    await generate(user)
    await user.click(screen.getByRole('button', { name: /^back$/i }))
    const name = await screen.findByLabelText(/^name$/i)
    expect(name).toHaveValue('my-laptop')
    await user.click(screen.getByRole('radio', { name: /org-wide/i }))
    await user.click(screen.getByRole('button', { name: /update command/i }))
    await screen.findByText(/Run these on the target machine/i)
    expect(create).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith('r-new', expect.objectContaining({ name: 'my-laptop', visibility: 'org' }))
  })

  it('cancel deletes the never-connected record and returns to the runners list', async () => {
    const user = userEvent.setup()
    render(<RunnerNewPage />)
    await generate(user)
    await user.click(screen.getByRole('button', { name: /cancel and delete this runner/i }))
    await waitFor(() => expect(unregister).toHaveBeenCalledWith('r-new'))
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/runners'))
  })

  it('cancel before generating anything just returns to the list', async () => {
    const user = userEvent.setup()
    render(<RunnerNewPage />)
    await user.click(await screen.findByRole('button', { name: /^cancel$/i }))
    expect(unregister).not.toHaveBeenCalled()
    expect(mockNavigate).toHaveBeenCalledWith('/runners')
  })

  it('shows the server refusal (name used by another member) on the name field', async () => {
    create.mockRejectedValue({ response: { status: 409, data: { message: "the runner name 'franemb' is already used in this organization; pick another name" } } })
    const user = userEvent.setup()
    render(<RunnerNewPage />)
    await user.type(await screen.findByLabelText(/^name$/i), 'franemb')
    await user.click(screen.getByRole('button', { name: /generate command/i }))
    expect(await screen.findByText(/already used in this organization/i)).toBeInTheDocument()
  })

  it('opens the runner once its daemon sends the first heartbeat', async () => {
    const user = userEvent.setup()
    render(<RunnerNewPage />)
    await generate(user)
    await screen.findByText(/Waiting for first heartbeat/i)
    getById.mockResolvedValue(pendingRunner({ state: 'online', runtimeInfo: { os: 'darwin' }, lastHeartbeatAt: new Date().toISOString() }))
    await waitFor(
      () => expect(mockNavigate).toHaveBeenCalledWith('/runners/r-new'),
      { timeout: 6_000 },
    )
  })
})