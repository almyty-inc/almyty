import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'

import { render } from '../../../../test/setup'
import { DeploymentsTab } from '../../deployments-tab'
import { makeDeployment, makeVersion, ollamaAdapter } from './fixtures'

vi.mock('../../../../lib/deployments-api', async () => {
  const actual = await vi.importActual<typeof import('../../../../lib/deployments-api')>('../../../../lib/deployments-api')
  return {
    ...actual,
    modelVersionsApi: { list: vi.fn(), get: vi.fn(), create: vi.fn(), delete: vi.fn() },
    modelDeploymentsApi: { list: vi.fn(), get: vi.fn(), create: vi.fn(), scale: vi.fn(), teardown: vi.fn(), delete: vi.fn() },
    modelAdaptersApi: { list: vi.fn() },
  }
})
vi.mock('../../../../lib/api', () => ({
  credentialsApi: { getAll: vi.fn().mockResolvedValue([]) },
  budgetsApi: { list: vi.fn().mockResolvedValue([]) },
}))
vi.mock('../../../../store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'test-org-id', name: 'Test Org' } }),
}))
const notify = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
vi.mock('../../../../store/app', () => ({ useNotifications: () => notify }))

import { modelDeploymentsApi, modelVersionsApi, modelAdaptersApi, DEPLOYMENT_POLL_MS, isInFlightState, isTerminalState } from '../../../../lib/deployments-api'

const list = modelDeploymentsApi.list as ReturnType<typeof vi.fn>
const scale = modelDeploymentsApi.scale as ReturnType<typeof vi.fn>
const teardown = modelDeploymentsApi.teardown as ReturnType<typeof vi.fn>
const create = modelDeploymentsApi.create as ReturnType<typeof vi.fn>

describe('state helpers', () => {
  it('polls for moving states only and treats torn_down / failed as terminal', () => {
    expect(DEPLOYMENT_POLL_MS).toBe(15_000)
    expect(['pending', 'deploying', 'scaling', 'tearing_down', 'degraded'].every((s) => isInFlightState(s as any))).toBe(true)
    expect(['ready', 'torn_down', 'failed', 'orphaned'].some((s) => isInFlightState(s as any))).toBe(false)
    expect(isTerminalState('torn_down')).toBe(true)
    expect(isTerminalState('failed')).toBe(true)
    expect(isTerminalState('ready')).toBe(false)
  })
})

describe('DeploymentsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(modelAdaptersApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([ollamaAdapter])
    ;(modelVersionsApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([makeVersion()])
    scale.mockResolvedValue(makeDeployment())
    teardown.mockResolvedValue(makeDeployment())
    create.mockResolvedValue(makeDeployment())
  })

  it('renders rows with states and spend and says when it is polling', async () => {
    list.mockResolvedValue([
      makeDeployment({ id: 'd-1', state: 'ready', actual: { replicas: 1, spentCents: 1234, ratePerHourCents: 50 } }),
      makeDeployment({ id: 'd-2', state: 'deploying' }),
    ])
    render(<DeploymentsTab />)
    expect(await screen.findByText('ready')).toBeInTheDocument()
    expect(screen.getByText('deploying')).toBeInTheDocument()
    expect(screen.getByText('$12.34')).toBeInTheDocument()
    expect(screen.getByText(/2 deployments, 1 in flight \(refreshing every 15s\)/)).toBeInTheDocument()
  })

  it('renders the error state with retry', async () => {
    list.mockRejectedValue(new Error('boom'))
    render(<DeploymentsTab />)
    expect(await screen.findByText("We couldn't load deployments")).toBeInTheDocument()
  })

  it('scales through the detail sheet after confirm and invalidates', async () => {
    list.mockResolvedValue([makeDeployment({ id: 'd-1', state: 'ready', desired: { replicas: 1 } })])
    render(<DeploymentsTab />)
    fireEvent.click(await screen.findByText('ready'))
    const input = await screen.findByLabelText('Replicas')
    fireEvent.change(input, { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Scale' }))
    await screen.findByText('Scale to 2 replicas?')
    fireEvent.click(screen.getAllByRole('button', { name: 'Scale' }).at(-1)!)
    await waitFor(() => expect(scale).toHaveBeenCalledWith('d-1', 2))
    await waitFor(() => expect(notify.success).toHaveBeenCalledWith('Scale requested', 'Desired replicas set to 2.'))
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
  })

  it('tears down through the detail sheet after confirm', async () => {
    list.mockResolvedValue([makeDeployment({ id: 'd-1', state: 'ready' })])
    render(<DeploymentsTab />)
    fireEvent.click(await screen.findByText('ready'))
    fireEvent.click(await screen.findByRole('button', { name: 'Tear down' }))
    await screen.findByText('Tear down this deployment?')
    fireEvent.click(screen.getAllByRole('button', { name: 'Tear down' }).at(-1)!)
    await waitFor(() => expect(teardown).toHaveBeenCalledWith('d-1'))
  })

  it('opens the deploy dialog and posts the body', async () => {
    list.mockResolvedValue([])
    render(<DeploymentsTab />)
    await screen.findByText('No deployments yet')
    fireEvent.click(screen.getByRole('button', { name: /^Deploy$/ }))
    await screen.findByText('Deploy a version', { selector: 'h2' })
    fireEvent.click(await screen.findByRole('radio', { name: /Ollama/ }))
    fireEvent.change(screen.getByLabelText('Version'), { target: { value: 'v-1' } })
    fireEvent.click(screen.getAllByRole('button', { name: /^Deploy$/ }).at(-1)!)
    await waitFor(() => expect(create).toHaveBeenCalledWith({ modelVersionId: 'v-1', providerType: 'ollama', desired: { replicas: 1 }, providerConfig: { baseUrl: 'http://localhost:11434' } }))
    await waitFor(() => expect(notify.success).toHaveBeenCalledWith('Deployment queued', expect.any(String)))
  })

  it('surfaces a server error on create', async () => {
    list.mockResolvedValue([])
    create.mockRejectedValue({ response: { data: { message: 'ADAPTER_UNKNOWN' } } })
    render(<DeploymentsTab />)
    await screen.findByText('No deployments yet')
    fireEvent.click(screen.getByRole('button', { name: /^Deploy$/ }))
    fireEvent.click(await screen.findByRole('radio', { name: /Ollama/ }))
    fireEvent.change(screen.getByLabelText('Version'), { target: { value: 'v-1' } })
    fireEvent.click(screen.getAllByRole('button', { name: /^Deploy$/ }).at(-1)!)
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith('Could not create deployment', 'ADAPTER_UNKNOWN'))
  })
})
