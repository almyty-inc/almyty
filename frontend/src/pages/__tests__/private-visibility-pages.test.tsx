import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { render } from '../../test/setup'
import { GatewayNewPage } from '../gateway-new'
import { GatewayEditForm } from '../../components/gateways/detail/gateway-edit-form'
import { ConnectProviderForm } from '../../components/llm-providers/connect-provider-form'
import { gatewaysApi, llmProvidersApi } from '../../lib/api'

/**
 * The "Private (just me)" choice on the gateway, provider and credential
 * create/edit flows -- which are pages, not dialogs -- has to reach the
 * server as visibility: 'private' with no team.
 */

vi.mock('../../lib/api', () => ({
  gatewaysApi: { create: vi.fn(), getAll: vi.fn().mockResolvedValue([]) },
  getApiBaseUrl: () => 'https://api.test',
  credentialsApi: { create: vi.fn(), getAll: vi.fn().mockResolvedValue([]) },
  toolsApi: { getAll: vi.fn().mockResolvedValue({ tools: [{ id: 't1', name: 'listPets', status: 'active', visibility: 'org' }] }) },
  agentsApi: { getAll: vi.fn().mockResolvedValue([]) },
  organizationsApi: { getTeams: vi.fn().mockResolvedValue([]) },
  llmProvidersApi: { connect: vi.fn(), providerTypes: vi.fn().mockResolvedValue([]), getModels: vi.fn().mockResolvedValue([]) },
}))

vi.mock('@/components/credential-picker', () => ({
  CredentialPicker: () => <div data-testid="credential-picker" />,
}))
vi.mock('@/lib/connections-api', () => ({
  connectionsApi: { list: vi.fn().mockResolvedValue([]) },
}))

vi.mock('../../store/app', () => ({
  useNotifications: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}))
vi.mock('../../store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'org-test', name: 'Test Org' } }),
}))

const mockNavigate = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return { ...actual, useNavigate: () => mockNavigate }
})

beforeEach(() => {
  vi.clearAllMocks()
  // Radix Select needs these in jsdom.
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false) as any
  Element.prototype.scrollIntoView = vi.fn() as any
})

const privateOption = () => screen.getByRole('radio', { name: /Private/ })

describe('share tools page', () => {
  it('is a page, not a dialog, and sends visibility private with no team', async () => {
    const user = userEvent.setup()
    vi.mocked(gatewaysApi.create).mockResolvedValue({ id: 'gw-new' })
    render(<GatewayNewPage />)

    expect(screen.getByRole('heading', { name: 'Share tools' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(await screen.findByLabelText(/listPets/))
    await user.click(screen.getByRole('button', { name: /^Advanced/ }))
    await user.click(screen.getByRole('button', { name: 'Change' }))
    await user.click(privateOption())
    await user.click(screen.getByRole('button', { name: 'Share 1 tool' }))

    await waitFor(() => expect(gatewaysApi.create).toHaveBeenCalled())
    expect(vi.mocked(gatewaysApi.create).mock.calls[0][0]).toMatchObject({
      name: 'listPets', type: 'tools', visibility: 'private', teamId: null, toolIds: ['t1'],
    })
    await waitFor(() => expect(mockNavigate.mock.calls.at(-1)?.[0]).toBe('/gateways/gw-new'))
  })

  it('has no agent or chat channel to pick, so nothing here can be a private chat channel', async () => {
    render(<GatewayNewPage />)
    await screen.findByLabelText(/listPets/)
    expect(screen.queryByText('Agent')).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: /^Protocol/ })).not.toBeInTheDocument()
    expect(screen.queryByText('Slack')).not.toBeInTheDocument()
  })
})

describe('connect a provider', () => {
  it('sends private with no team once the scope is changed', async () => {
    const user = userEvent.setup()
    vi.mocked(llmProvidersApi.connect).mockResolvedValue({ provider: { id: 'p-1', name: 'Ollama', type: 'ollama' }, models: [] })
    render(<ConnectProviderForm type="ollama" onConnected={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Change' }))
    await user.click(privateOption())
    await user.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(llmProvidersApi.connect).toHaveBeenCalled())
    expect(vi.mocked(llmProvidersApi.connect).mock.calls[0][0]).toMatchObject({ type: 'ollama', visibility: 'private', teamId: null })
  })
})

describe('gateway edit form', () => {
  it('loads the stored private visibility and keeps it on an unrelated edit', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(
      <GatewayEditForm
        gateway={{ id: 'gw-1', name: 'Mine', endpoint: '/mine', type: 'mcp', status: 'active', visibility: 'private', teamId: null }}
        isSaving={false}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    )
    expect(privateOption()).toHaveAttribute('aria-checked', 'true')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('visibility')

    await user.click(screen.getByRole('radio', { name: /Org-wide/ }))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2))
    expect(onSubmit.mock.calls[1][0]).toMatchObject({ visibility: 'org', teamId: null })
  })
})
