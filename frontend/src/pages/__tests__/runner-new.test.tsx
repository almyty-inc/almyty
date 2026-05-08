import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { render } from '../../test/setup'
import { RunnerNewPage } from '../runner-new'

vi.mock('../../lib/api', () => ({
  runnersApi: { getAll: vi.fn() },
}))
vi.mock('../../store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'o1', name: 'Org' } }),
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

describe('RunnerNewPage', () => {
  beforeEach(() => {
    getAll.mockReset()
    mockNavigate.mockReset()
    mockSuccess.mockReset()
    getAll.mockResolvedValue([])
  })

  it('rejects names already taken by an existing runner', async () => {
    getAll.mockResolvedValue([{ id: 'r1', name: 'taken-name', state: 'online', lastHeartbeatAt: new Date().toISOString() }])
    const user = userEvent.setup()
    render(<RunnerNewPage />)
    const nameInput = await screen.findByLabelText(/^name$/i)
    await user.type(nameInput, 'taken-name')
    await waitFor(() => {
      expect(screen.getByText(/already registered/i)).toBeInTheDocument()
    })
  })

  it('rejects invalid name characters via zod regex', async () => {
    const user = userEvent.setup()
    render(<RunnerNewPage />)
    const nameInput = await screen.findByLabelText(/^name$/i)
    await user.type(nameInput, 'has spaces')
    await user.click(screen.getByRole('button', { name: /generate command/i }))
    await waitFor(() => {
      expect(screen.getByText(/letters, numbers/i)).toBeInTheDocument()
    })
  })

  it('generates the correct start command for the given name + labels', async () => {
    const user = userEvent.setup()
    render(<RunnerNewPage />)
    await user.type(await screen.findByLabelText(/^name$/i), 'my-laptop')
    await user.click(screen.getByRole('button', { name: /add label/i }))
    const keyInputs = screen.getAllByPlaceholderText('key')
    const valueInputs = screen.getAllByPlaceholderText('value')
    await user.type(keyInputs[0], 'env')
    await user.type(valueInputs[0], 'dev')
    await user.click(screen.getByRole('button', { name: /generate command/i }))

    await waitFor(() => {
      expect(screen.getByText(/Run these on the target machine/i)).toBeInTheDocument()
    })
    expect(screen.getByText('npx @almyty/runner start --name my-laptop --label env=dev')).toBeInTheDocument()
  })

  it('transitions from waiting to a navigate() call once the runner heartbeats', async () => {
    // Two queries fire from the page: the existing-names check + the
    // post-submit polling. We start with no runners, then change the
    // mock to return our runner with state online + a recent heartbeat.
    getAll.mockResolvedValue([])
    const user = userEvent.setup()
    render(<RunnerNewPage />)
    await user.type(await screen.findByLabelText(/^name$/i), 'my-laptop')
    await user.click(screen.getByRole('button', { name: /generate command/i }))
    await waitFor(() => screen.getByText(/Waiting for first heartbeat/i))

    // Simulate heartbeat: the next poll returns our runner online.
    getAll.mockResolvedValue([{
      id: 'r-new',
      name: 'my-laptop',
      state: 'online',
      lastHeartbeatAt: new Date().toISOString(),
    }])

    await waitFor(
      () => expect(mockNavigate).toHaveBeenCalledWith('/runners/r-new'),
      { timeout: 6_000 },
    )
  })
})
