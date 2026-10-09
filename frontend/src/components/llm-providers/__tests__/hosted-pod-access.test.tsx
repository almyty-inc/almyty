import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { render } from '@/test/setup'
import { HostedPodAccess } from '../hosted-pod-access'

vi.mock('@/lib/api', () => ({ environmentsApi: { list: vi.fn() } }))
vi.mock('@/store/organization', () => {
  const state = { currentOrganization: { id: 'o1', name: 'Org' } }
  return { useOrganizationStore: (select?: any) => (select ? select(state) : state) }
})
vi.mock('@/store/auth', () => {
  const state = { user: { id: 'me' } }
  return { useAuthStore: (select?: any) => (select ? select(state) : state) }
})

import { environmentsApi } from '@/lib/api'
const list = environmentsApi.list as ReturnType<typeof vi.fn>

const LABEL = 'Let my hosted machines use this provider'

describe('HostedPodAccess', () => {
  beforeEach(() => {
    list.mockReset()
    list.mockResolvedValue({ success: true, data: [], enabled: true })
  })

  it("is the owner's switch on a private provider, and sends hostedPodAccess", async () => {
    const user = userEvent.setup()
    const change = vi.fn()
    render(<HostedPodAccess provider={{ visibility: 'private', ownerUserId: 'me', hostedPodAccess: false }} onChange={change} />)
    const toggle = await screen.findByRole('switch', { name: LABEL })
    expect(toggle).not.toBeChecked()
    expect(screen.getByText(/the key never goes onto the machine/)).toBeInTheDocument()
    await user.click(toggle)
    expect(change).toHaveBeenCalledWith(true)
  })

  it('shows a given grant as on', async () => {
    render(<HostedPodAccess provider={{ visibility: 'private', ownerUserId: 'me', hostedPodAccess: true }} onChange={vi.fn()} />)
    expect(await screen.findByRole('switch', { name: LABEL })).toBeChecked()
  })

  it('is not offered on a shared provider, to someone else, or when hosted machines are off', async () => {
    const { rerender } = render(<HostedPodAccess provider={{ visibility: 'org', ownerUserId: 'me' }} onChange={vi.fn()} />)
    await waitFor(() => expect(list).toHaveBeenCalled())
    expect(screen.queryByRole('switch', { name: LABEL })).toBeNull()
    rerender(<HostedPodAccess provider={{ visibility: 'private', ownerUserId: 'them' }} onChange={vi.fn()} />)
    expect(screen.queryByRole('switch', { name: LABEL })).toBeNull()
  })

  it('stays hidden when hosted machines are off on this server', async () => {
    list.mockResolvedValue({ success: true, data: [], enabled: false })
    render(<HostedPodAccess provider={{ visibility: 'private', ownerUserId: 'me' }} onChange={vi.fn()} />)
    await waitFor(() => expect(list).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByRole('switch', { name: LABEL })).toBeNull()
  })
})
