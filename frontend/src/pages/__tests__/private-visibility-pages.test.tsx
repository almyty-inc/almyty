import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useForm } from 'react-hook-form'

import { render } from '../../test/setup'
import { GatewayNewPage } from '../gateway-new'
import { CredentialNewPage } from '../credential-new'
import { GatewayEditForm } from '../../components/gateways/detail/gateway-edit-form'
import { EditProviderForm } from '../../components/llm-providers/edit-provider-form'
import { CreateProviderForm } from '../../components/llm-providers/create-provider-form'
import { buildProviderCreateBody, buildProviderUpdateBody } from '../../components/llm-providers/schema'
import { credentialsApi, gatewaysApi } from '../../lib/api'

/**
 * The "Private (just me)" choice on the gateway, provider and credential
 * create/edit flows -- which are pages now, not dialogs -- has to reach the
 * server as visibility: 'private' with no team.
 */

vi.mock('../../lib/api', () => ({
  gatewaysApi: { create: vi.fn(), getAll: vi.fn().mockResolvedValue([]) },
  getApiBaseUrl: () => 'https://api.test',
  credentialsApi: { create: vi.fn(), getAll: vi.fn().mockResolvedValue([]) },
  agentsApi: { getAll: vi.fn().mockResolvedValue([]) },
  organizationsApi: { getTeams: vi.fn().mockResolvedValue([]) },
  llmProvidersApi: { testConnection: vi.fn(), getModels: vi.fn().mockResolvedValue([]) },
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

describe('new gateway page', () => {
  it('is a page, not a dialog, and sends visibility private with no team', async () => {
    const user = userEvent.setup()
    vi.mocked(gatewaysApi.create).mockResolvedValue({ id: 'gw-new' })
    render(<GatewayNewPage />)

    expect(screen.getByRole('heading', { name: 'Create gateway' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.type(screen.getByLabelText(/^Name/), 'Mine')
    await user.click(screen.getByRole('combobox', { name: /^Protocol/ }))
    await user.click((await screen.findAllByText('MCP - Model Context Protocol')).at(-1)!)
    await user.click(privateOption())
    await user.click(screen.getByRole('button', { name: 'Create gateway' }))

    await waitFor(() => expect(gatewaysApi.create).toHaveBeenCalled())
    expect(vi.mocked(gatewaysApi.create).mock.calls[0][0]).toMatchObject({
      name: 'Mine', type: 'mcp', visibility: 'private', teamId: null,
    })
    await waitFor(() => expect(mockNavigate.mock.calls.at(-1)?.[0]).toBe('/gateways/gw-new'))
  })

  it('will not submit a private chat channel', async () => {
    const user = userEvent.setup()
    render(<GatewayNewPage />)

    await user.click(screen.getByText('Agent'))
    await user.type(screen.getByLabelText(/^Name/), 'Support')
    await user.click(screen.getByRole('combobox', { name: /^Protocol/ }))
    await user.click((await screen.findAllByText('Slack')).at(-1)!)
    await user.click(privateOption())

    expect(screen.getByText(/A chat channel can't be private/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create gateway' })).toBeDisabled()
    expect(gatewaysApi.create).not.toHaveBeenCalled()
  })
})

describe('new credential page', () => {
  it('sends visibility private', async () => {
    const user = userEvent.setup()
    vi.mocked(credentialsApi.create).mockResolvedValue({ id: 'cred-new' })
    render(<CredentialNewPage />)

    expect(screen.getByRole('heading', { name: 'Add credential' })).toBeInTheDocument()
    await user.type(screen.getByLabelText(/^Name/), 'My key')
    await user.type(screen.getByLabelText(/^API key/), 'sk-123456789')
    await user.click(privateOption())
    await user.click(screen.getByRole('button', { name: 'Create credential' }))

    await waitFor(() => expect(credentialsApi.create).toHaveBeenCalled())
    expect(vi.mocked(credentialsApi.create).mock.calls[0][0]).toMatchObject({
      name: 'My key', visibility: 'private', teamId: null,
    })
    await waitFor(() => expect(mockNavigate.mock.calls.at(-1)?.[0]).toBe('/credentials'))
  })
})

describe('provider forms', () => {
  it('create form forwards private to the create body', async () => {
    const user = userEvent.setup()
    const mutate = vi.fn()
    function Harness() {
      const form = useForm<any>({ defaultValues: { name: 'Mine', type: 'ollama', apiKey: '', apiUrl: '' } })
      return <CreateProviderForm createForm={form} createProviderMutation={{ isPending: false, mutate } as any} onCancel={() => {}} />
    }
    render(<Harness />)
    await user.click(privateOption())
    await user.click(screen.getByRole('button', { name: 'Add inference provider' }))

    await waitFor(() => expect(mutate).toHaveBeenCalled())
    const body = buildProviderCreateBody(mutate.mock.calls[0][0])
    expect(body).toMatchObject({ name: 'Mine', type: 'ollama', visibility: 'private', teamId: null })
  })

  it('edit form starts at the stored scope and sends private only when changed', async () => {
    const user = userEvent.setup()
    const mutate = vi.fn()
    function Harness() {
      const form = useForm<any>({ defaultValues: { name: 'prod', model: '', maxTokens: 4096, temperature: 0.7 } })
      return (
        <EditProviderForm
          editForm={form}
          providerToEdit={{ id: 'p-1', type: 'openai', name: 'prod', visibility: 'org', teamId: null }}
          updateProviderMutation={{ isPending: false, mutate } as any}
          availableModels={[]}
          modelsLoading={false}
          onCancel={() => {}}
        />
      )
    }
    render(<Harness />)
    expect(screen.getByRole('radio', { name: /Org-wide/ })).toHaveAttribute('aria-checked', 'true')

    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1))
    expect(buildProviderUpdateBody(mutate.mock.calls[0][0].data)).not.toHaveProperty('visibility')

    await user.click(privateOption())
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2))
    expect(buildProviderUpdateBody(mutate.mock.calls[1][0].data)).toMatchObject({ visibility: 'private', teamId: null })
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
