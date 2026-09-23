/**
 * The Settings > Connections pages that used to be sheets:
 * /settings/connections/connect[/:connectorKey] and /settings/connections/:id,
 * driven under a real router.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'

import { renderAtRoute } from '../../../test/render-at-route'
import { ConnectionConnectPage, ConnectionDetailRoutePage, safeReturnTo } from '../../../pages/connection-pages'
import { connectionsApi, connectorsApi } from '../../../lib/connections-api'
import type { Connection, Connector } from '@/types/connections'

vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))

vi.mock('../../../lib/connections-api', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/connections-api')>('../../../lib/connections-api')
  return {
    ...actual,
    connectorsApi: { list: vi.fn(), create: vi.fn() },
    connectionsApi: {
      list: vi.fn(),
      get: vi.fn(),
      connect: vi.fn(),
      complete: vi.fn(),
      validate: vi.fn(),
      rotate: vi.fn(),
      remove: vi.fn(),
      listGrants: vi.fn().mockResolvedValue([]),
      addGrant: vi.fn(),
      removeGrant: vi.fn(),
    },
  }
})

vi.mock('../../../lib/api', () => ({
  organizationsApi: { getById: vi.fn().mockResolvedValue({ id: 'test-org-id', plan: 'pro', settings: {} }), getMembers: vi.fn().mockResolvedValue([]), getTeams: vi.fn().mockResolvedValue([]) },
  agentsApi: { getAll: vi.fn().mockResolvedValue([]) },
  workspacesApi: { getAll: vi.fn().mockResolvedValue([]) },
}))

const notify = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
vi.mock('../../../store/app', () => ({ useNotifications: () => notify }))
vi.mock('../../../store/organization', () => ({
  useOrganizationStore: (selector?: (s: any) => any) => {
    const state = { currentOrganization: { id: 'test-org-id', name: 'Test Org' } }
    return selector ? selector(state) : state
  },
}))

const openai: Connector = {
  key: 'openai',
  kind: 'inference',
  displayName: 'OpenAI',
  connect: [{ type: 'api_key', label: 'API key', schema: { type: 'object', properties: { apiKey: { type: 'string', title: 'API key', 'x-secret': true } }, required: ['apiKey'] } }],
}

function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'conn-1',
    name: 'OpenAI prod',
    connectorKey: 'openai',
    kind: 'inference',
    owner: 'org',
    health: { status: 'expired', error: 'token expired' },
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

const CONNECT_PATHS = ['/settings/connections', '/settings/connections/:id', '/settings/connections/connect/:connectorKey']

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(connectorsApi.list).mockResolvedValue([openai])
  vi.mocked(connectionsApi.list).mockResolvedValue([connection()])
})

describe('/settings/connections/connect/:connectorKey', () => {
  it('connects through a real form and lands on the new connection', async () => {
    const created = connection({ id: 'conn-9', name: 'OpenAI', health: { status: 'valid' } })
    vi.mocked(connectionsApi.connect).mockResolvedValue({ pending: false, connection: created })
    renderAtRoute(<ConnectionConnectPage />, { path: '/settings/connections/connect/:connectorKey', url: '/settings/connections/connect/openai', paths: CONNECT_PATHS.slice(0, 2) })

    expect(await screen.findByRole('heading', { name: 'Connect OpenAI' })).toBeInTheDocument()
    expect(screen.getByTestId('connect-form').tagName).toBe('FORM')
    fireEvent.change(await screen.findByLabelText('API key'), { target: { value: 'sk-page' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(connectionsApi.connect).toHaveBeenCalledWith('openai', { method: 'api_key', owner: 'org', input: { apiKey: 'sk-page' } }))
    expect(await screen.findByText('at /settings/connections/conn-9')).toBeInTheDocument()
    expect(notify.success).toHaveBeenCalledWith('Connected', expect.stringContaining('OpenAI'))
  })

  it('returns to a same-origin returnTo instead', async () => {
    vi.mocked(connectionsApi.connect).mockResolvedValue({ pending: false, connection: connection({ id: 'conn-9' }) })
    renderAtRoute(<ConnectionConnectPage />, {
      path: '/settings/connections/connect/:connectorKey',
      url: '/settings/connections/connect/openai?returnTo=%2Fmodels%3Ftab%3Dproviders',
      paths: ['/models'],
    })
    fireEvent.change(await screen.findByLabelText('API key'), { target: { value: 'sk' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(await screen.findByText('at /models')).toBeInTheDocument()
  })

  it('picking from the list moves to the connector URL', async () => {
    const anthropic: Connector = { ...openai, key: 'anthropic', displayName: 'Anthropic' }
    vi.mocked(connectorsApi.list).mockResolvedValue([openai, anthropic])
    renderAtRoute(<ConnectionConnectPage />, { path: '/settings/connections/connect', paths: ['/settings/connections/connect/:connectorKey'] })
    fireEvent.click(await screen.findByTestId('connector-option-anthropic'))
    expect(await screen.findByText('at /settings/connections/connect/anthropic')).toBeInTheDocument()
  })
})

describe('safeReturnTo', () => {
  it('only honours same-origin paths', () => {
    expect(safeReturnTo('/models')).toBe('/models')
    expect(safeReturnTo('//evil.example')).toBeNull()
    expect(safeReturnTo('https://evil.example')).toBeNull()
    expect(safeReturnTo(null)).toBeNull()
  })
})

describe('/settings/connections/:id', () => {
  const DETAIL = { path: '/settings/connections/:id', url: '/settings/connections/conn-1', paths: ['/settings/connections'] }

  it('shows health, the last error, actions and grants on the page', async () => {
    renderAtRoute(<ConnectionDetailRoutePage />, DETAIL)
    expect(await screen.findByRole('heading', { name: 'OpenAI prod' })).toBeInTheDocument()
    expect(screen.getByTestId('connection-last-error')).toHaveTextContent('token expired')
    expect(screen.getByRole('button', { name: 'Validate' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Who can use it' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('rotates inline through POST /connections/:id/rotate', async () => {
    vi.mocked(connectionsApi.rotate).mockResolvedValue({ pending: false, connection: connection({ health: { status: 'valid' } }) })
    renderAtRoute(<ConnectionDetailRoutePage />, DETAIL)
    fireEvent.click(await screen.findByRole('button', { name: 'Rotate' }))
    const flow = within(await screen.findByTestId('connect-flow'))
    expect(flow.getByText('Rotate OpenAI prod')).toBeInTheDocument()
    fireEvent.change(await flow.findByLabelText('API key'), { target: { value: 'sk-new' } })
    fireEvent.click(flow.getByRole('button', { name: 'Rotate' }))
    await waitFor(() => expect(connectionsApi.rotate).toHaveBeenCalledWith('conn-1', { input: { apiKey: 'sk-new' } }))
    await waitFor(() => expect(notify.success).toHaveBeenCalledWith('Secret rotated', expect.any(String)))
    expect(screen.queryByTestId('connect-flow')).not.toBeInTheDocument()
  })

  it('disconnects after confirming and returns to the gallery', async () => {
    vi.mocked(connectionsApi.remove).mockResolvedValue({ revoked: true })
    renderAtRoute(<ConnectionDetailRoutePage />, DETAIL)
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }))
    const confirm = await screen.findByRole('alertdialog')
    expect(confirm).toHaveTextContent('Disconnect OpenAI prod?')
    fireEvent.click(within(confirm).getByRole('button', { name: 'Disconnect' }))

    await waitFor(() => expect(connectionsApi.remove).toHaveBeenCalledWith('conn-1'))
    expect(await screen.findByText('at /settings/connections')).toBeInTheDocument()
  })

  it('says so when the connection does not exist', async () => {
    renderAtRoute(<ConnectionDetailRoutePage />, { ...DETAIL, url: '/settings/connections/gone' })
    expect(await screen.findAllByText('Connection not found')).not.toHaveLength(0)
  })
})
