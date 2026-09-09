import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'

import { render } from '../../../test/setup'
import { PolicyDialog } from '../policy-dialog'
import { connectionPoliciesApi } from '../../../lib/connections-governance-api'
import { connectorsApi } from '../../../lib/connections-api'
import type { ConnectionPolicy } from '@/types/connections-governance'

vi.mock('../../../lib/connections-governance-api', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/connections-governance-api')>('../../../lib/connections-governance-api')
  return {
    ...actual,
    connectionPoliciesApi: { list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
  }
})

vi.mock('../../../lib/connections-api', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/connections-api')>('../../../lib/connections-api')
  return { ...actual, connectorsApi: { list: vi.fn(), create: vi.fn() } }
})

const notify = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
vi.mock('../../../store/app', () => ({ useNotifications: () => notify }))

function saved(overrides: Partial<ConnectionPolicy> = {}): ConnectionPolicy {
  return { id: 'p-new', kind: 'connector_allowlist', name: null, rule: { connectorKeys: [] }, enabled: true, createdBy: null, createdAt: '', updatedAt: '', ...overrides }
}

describe('PolicyDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(connectorsApi.list).mockResolvedValue([
      { key: 'openai', kind: 'inference', displayName: 'OpenAI', connect: [] },
      { key: 'slack', kind: 'channel', displayName: 'Slack', connect: [] },
    ])
    vi.mocked(connectionPoliciesApi.create).mockResolvedValue(saved())
    vi.mocked(connectionPoliciesApi.update).mockResolvedValue(saved())
  })

  it('posts a connector allow list with the picked connectors and owner', async () => {
    const onOpenChange = vi.fn()
    render(<PolicyDialog open onOpenChange={onOpenChange} />)
    expect(await screen.findByRole('heading', { name: 'Add policy' })).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Approved vendors' } })
    fireEvent.click(await screen.findByRole('checkbox', { name: 'OpenAI' }))
    expect(screen.getByTestId('connector-chip-openai')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Organization connections' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add policy' }))

    await waitFor(() =>
      expect(connectionPoliciesApi.create).toHaveBeenCalledWith({ kind: 'connector_allowlist', name: 'Approved vendors', rule: { connectorKeys: ['openai'], owners: ['org'] }, enabled: true }),
    )
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(notify.success).toHaveBeenCalledWith('Policy added', expect.any(String))
  })

  it('refuses an empty allow list before calling the server', async () => {
    render(<PolicyDialog open onOpenChange={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add policy' }))
    expect(await screen.findByTestId('policy-errors')).toHaveTextContent('Pick at least one connector')
    expect(connectionPoliciesApi.create).not.toHaveBeenCalled()
  })

  it('posts a deny list for personal connections', async () => {
    render(<PolicyDialog open onOpenChange={vi.fn()} initialKind="connector_denylist" />)
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Slack' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Personal connections' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add policy' }))
    await waitFor(() => expect(connectionPoliciesApi.create).toHaveBeenCalledWith({ kind: 'connector_denylist', name: null, rule: { connectorKeys: ['slack'], owners: ['user'] }, enabled: true }))
  })

  it('posts a scope rule from principal kinds, environment chips and the approved toggle', async () => {
    render(<PolicyDialog open onOpenChange={vi.fn()} />)
    fireEvent.change(await screen.findByLabelText('Kind'), { target: { value: 'scope_rule' } })
    expect(screen.getByRole('checkbox', { name: 'Agents' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('environment-chip-production')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Workspaces' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Teams' }))
    const envInput = screen.getByLabelText('Add environment')
    fireEvent.change(envInput, { target: { value: 'Staging' } })
    fireEvent.keyDown(envInput, { key: 'Enter' })
    expect(screen.getByTestId('environment-chip-staging')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove production' }))
    fireEvent.click(screen.getByRole('switch', { name: /Approved connectors only/ }))

    fireEvent.click(screen.getByRole('button', { name: 'Add policy' }))
    await waitFor(() =>
      expect(connectionPoliciesApi.create).toHaveBeenCalledWith({ kind: 'scope_rule', name: null, rule: { principalKinds: ['agent', 'team'], environments: ['staging'], requireOwner: 'org' }, enabled: true }),
    )
  })

  it('posts an expiry rule with the defaults 90 and 7, and validates the warning window', async () => {
    render(<PolicyDialog open onOpenChange={vi.fn()} />)
    fireEvent.change(await screen.findByLabelText('Kind'), { target: { value: 'expiry_rule' } })
    expect(screen.getByLabelText('Maximum age (days)')).toHaveValue(90)
    expect(screen.getByLabelText('Warn ahead (days)')).toHaveValue(7)

    fireEvent.change(screen.getByLabelText('Warn ahead (days)'), { target: { value: '120' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add policy' }))
    expect(await screen.findByTestId('policy-errors')).toHaveTextContent('Warning must come before the maximum age')
    expect(connectionPoliciesApi.create).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Warn ahead (days)'), { target: { value: '14' } })
    fireEvent.click(screen.getByRole('switch', { name: 'Revoke grants on expiry' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add policy' }))
    await waitFor(() => expect(connectionPoliciesApi.create).toHaveBeenCalledWith({ kind: 'expiry_rule', name: null, rule: { maxAgeDays: 90, warnDays: 14, enforce: false }, enabled: true }))
  })

  it('posts a rotation rule with the default 90 days, connectors optional', async () => {
    render(<PolicyDialog open onOpenChange={vi.fn()} />)
    fireEvent.change(await screen.findByLabelText('Kind'), { target: { value: 'rotation_rule' } })
    expect(screen.getByLabelText('Rotate every (days)')).toHaveValue(90)
    fireEvent.change(screen.getByLabelText('Rotate every (days)'), { target: { value: '30' } })
    fireEvent.click(await screen.findByRole('checkbox', { name: 'OpenAI' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add policy' }))
    await waitFor(() => expect(connectionPoliciesApi.create).toHaveBeenCalledWith({ kind: 'rotation_rule', name: null, rule: { everyDays: 30, requireProviderApi: true, connectorKeys: ['openai'] }, enabled: true }))
  })

  it('patches an existing policy without the kind and shows server-side problems', async () => {
    const existing = saved({ id: 'p1', kind: 'expiry_rule', name: 'Quarterly', rule: { maxAgeDays: 90, warnDays: 7, enforce: true } })
    vi.mocked(connectionPoliciesApi.update).mockRejectedValueOnce({ response: { data: { code: 'CONNECTION_POLICY_INVALID', message: 'bad', errors: ['warnDays must be smaller than maxAgeDays'] } } })
    render(<PolicyDialog open onOpenChange={vi.fn()} policy={existing} />)
    expect(await screen.findByRole('heading', { name: 'Edit policy' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Maximum age (days)'), { target: { value: '60' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }))
    await waitFor(() => expect(connectionPoliciesApi.update).toHaveBeenCalledWith('p1', { name: 'Quarterly', rule: { maxAgeDays: 60, warnDays: 7, enforce: true } }))
    expect(await screen.findByTestId('policy-errors')).toHaveTextContent('warnDays must be smaller than maxAgeDays')
  })
})
