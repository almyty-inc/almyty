import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import { render } from '../../test/setup'
import { RunnerNewPage } from '../runner-new'

vi.mock('../../lib/api', () => ({ runnersApi: { getAll: vi.fn(), create: vi.fn(), unregister: vi.fn() } }))
vi.mock('../../store/organization', () => ({ useOrganizationStore: () => ({ currentOrganization: { id: 'o1', name: 'Org' } }) }))
vi.mock('../../store/auth', () => ({ useAuthStore: () => ({ user: { id: 'me' } }) }))
vi.mock('../../store/app', () => ({ useNotifications: () => ({ success: vi.fn() }) }))
import { runnersApi } from '../../lib/api'

describe('RunnerNewPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(runnersApi.getAll).mockResolvedValue([])
  })
  it('shows the complete unified CLI path immediately without creating a pending runner', async () => {
    render(<RunnerNewPage />)
    expect(screen.getByText('npm i -g @almyty/cli')).toBeInTheDocument()
    expect(screen.getByText('almyty login')).toBeInTheDocument()
    expect(screen.getByText('almyty runner start')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByText(/hostname automatically/)).toBeInTheDocument()
    expect(screen.getByText(/more than one organization/)).toBeInTheDocument()
    await screen.findByText(/Once connected/)
    expect(runnersApi.create).not.toHaveBeenCalled()
    expect(runnersApi.unregister).not.toHaveBeenCalled()
  })
  it('links to the existing runner rather than requiring it to be deleted', async () => {
    vi.mocked(runnersApi.getAll).mockResolvedValue([{ id: 'r1', name: 'build-box', state: 'online', ownerUserId: 'me' }])
    render(<RunnerNewPage />)
    expect(await screen.findByRole('link', { name: 'build-box' })).toHaveAttribute('href', '/runners/r1')
    expect(screen.getByText(/Starting it again reconnects/)).toBeInTheDocument()
    expect(runnersApi.create).not.toHaveBeenCalled()
  })
})
