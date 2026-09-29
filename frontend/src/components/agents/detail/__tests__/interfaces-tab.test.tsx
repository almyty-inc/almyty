import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import { readFileSync } from 'fs'
import { join } from 'path'

import { render } from '../../../../test/setup'
import { InterfacesTab } from '../interfaces-tab'

vi.mock('@/lib/api', () => ({
  gatewaysApi: { getAll: vi.fn() },
  getApiBaseUrl: () => 'https://api.test',
}))
vi.mock('@/lib/agent-apps', async () => {
  const actual = await vi.importActual<typeof import('@/lib/agent-apps')>('@/lib/agent-apps')
  return { ...actual, appPlacesApi: { usedBy: vi.fn(), appForGateway: vi.fn() } }
})

import { gatewaysApi } from '@/lib/api'
import { appPlacesApi } from '@/lib/agent-apps'

beforeEach(() => {
  vi.mocked(gatewaysApi.getAll).mockReset()
  vi.mocked(appPlacesApi.usedBy).mockReset()
})

/**
 * The agent's Interfaces tab says where the agent is in front of people
 * and links there. Putting it anywhere is done on the app, so nothing on
 * this tab creates or edits a place.
 */
describe('InterfacesTab (read-only "Used in")', () => {
  it('lists each app and place with a link to that place on the app', async () => {
    vi.mocked(appPlacesApi.usedBy).mockResolvedValue([
      {
        slug: 'acme-support',
        name: 'Acme support',
        places: [
          { target: 'slack', status: 'live' },
          { target: 'web', status: 'draft' },
        ],
      },
      { slug: 'billing', name: 'Billing desk', places: [] },
    ])
    vi.mocked(gatewaysApi.getAll).mockResolvedValue({ gateways: [] } as any)
    render(<InterfacesTab agentId="agent-1" agentName="Support" />)

    const rows = await screen.findAllByTestId('used-in-row')
    expect(rows.map((r) => r.textContent)).toEqual(['Acme supportSlackLive', 'Acme supportWeb appDraft'])
    expect(rows[0]).toHaveAttribute('href', '/apps/acme-support/distributions/slack')
    expect(rows[1]).toHaveAttribute('href', '/apps/acme-support/distributions/web')
    expect(screen.getByRole('link', { name: /Billing desk/ })).toHaveAttribute('href', '/apps/billing')
    expect(appPlacesApi.usedBy).toHaveBeenCalledWith('agent-1')
  })

  it('creates and edits nothing: no form, no field, no deploy action', async () => {
    vi.mocked(appPlacesApi.usedBy).mockResolvedValue([
      { slug: 'acme-support', name: 'Acme support', places: [{ target: 'slack', status: 'live' }] },
    ])
    vi.mocked(gatewaysApi.getAll).mockResolvedValue({ gateways: [] } as any)
    const { container } = render(<InterfacesTab agentId="agent-1" />)
    await screen.findAllByTestId('used-in-row')
    expect(container.querySelector('form, input, textarea, select')).toBeNull()
    expect(screen.queryAllByRole('button')).toEqual([])
    const source = readFileSync(join(__dirname, '../interfaces-tab.tsx'), 'utf8')
    expect(source).not.toMatch(/useMutation|gatewaysApi\.(create|update|delete)/)
  })

  it('lists gateways that serve the agent outside any app, and leaves out the ones an app owns', async () => {
    vi.mocked(appPlacesApi.usedBy).mockResolvedValue([])
    vi.mocked(gatewaysApi.getAll).mockResolvedValue({
      gateways: [
        { id: 'gw-a2a', name: 'Support over A2A', type: 'a2a', configuration: {} },
        { id: 'gw-app', name: 'Acme (slack)', type: 'slack', configuration: { appId: 'app-1' } },
      ],
    } as any)
    render(<InterfacesTab agentId="agent-1" />)

    const section = (await screen.findByText('Also served by gateways')).closest('section')!
    const links = within(section).getAllByRole('link')
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAttribute('href', '/gateways/gw-a2a')
    expect(screen.queryByText('Acme (slack)')).toBeNull()
  })

  it('points to apps when the agent is nowhere yet', async () => {
    vi.mocked(appPlacesApi.usedBy).mockResolvedValue([])
    vi.mocked(gatewaysApi.getAll).mockResolvedValue({ gateways: [] } as any)
    render(<InterfacesTab agentId="agent-1" agentName="Support" />)
    expect(await screen.findByText('Not in front of anyone yet')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Go to apps' })).toHaveAttribute('href', '/apps')
  })
})
