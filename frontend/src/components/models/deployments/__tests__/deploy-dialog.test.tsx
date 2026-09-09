import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'

import { render } from '../../../../test/setup'
import { DeployDialog, buildDeployBody, describeBudget } from '../deploy-dialog'
import { hfAdapter, makeVersion, ollamaAdapter } from './fixtures'

vi.mock('../../../../lib/api', () => ({
  credentialsApi: { getAll: vi.fn() },
  budgetsApi: { list: vi.fn() },
}))

vi.mock('../../../../lib/connections-api', () => ({
  connectionsApi: {
    list: vi.fn().mockResolvedValue([
      { id: 'conn-hf', name: 'HF endpoints', connectorKey: 'deploy-huggingface-endpoints', kind: 'deployment', owner: 'org', health: { status: 'valid' }, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'conn-modal', name: 'Modal', connectorKey: 'modal', kind: 'deployment', owner: 'org', health: { status: 'valid' }, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'conn-openai', name: 'OpenAI', connectorKey: 'openai', kind: 'inference', owner: 'org', health: { status: 'valid' }, createdAt: '2026-01-01T00:00:00.000Z' },
    ]),
  },
}))

vi.mock('../../../../store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'test-org-id', name: 'Test Org' } }),
}))

import { budgetsApi, credentialsApi } from '../../../../lib/api'

const mockedCredentials = credentialsApi.getAll as ReturnType<typeof vi.fn>
const mockedBudgets = budgetsApi.list as ReturnType<typeof vi.fn>

describe('buildDeployBody', () => {
  const base = { adapter: ollamaAdapter, versionId: 'v-1', desired: { hardware: '', replicas: '1', minScale: '', maxScale: '', quantization: '', region: '', privacyTier: '' as const }, config: { baseUrl: 'http://gpu:11434' }, credentialId: '', budgetId: '' }

  it('needs an adapter and a version', () => {
    const r = buildDeployBody({ ...base, adapter: null, versionId: '' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['adapter', 'versionId'])
  })

  it('carries the schema errors under config.*', () => {
    const r = buildDeployBody({ ...base, config: { baseUrl: '', hourlyRateCents: 'x' } })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors['config.baseUrl']).toMatch(/required/)
      expect(r.errors['config.hourlyRateCents']).toMatch(/number/)
    }
  })

  it('rejects fractional replicas and min above max', () => {
    const r = buildDeployBody({ ...base, desired: { ...base.desired, replicas: '1.5', minScale: '3', maxScale: '1' } })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors.replicas).toMatch(/whole number/)
      expect(r.errors.maxScale).toMatch(/at least min scale/)
    }
  })

  it('leaves out empty desired fields, config, credential and budget', () => {
    const r = buildDeployBody({ ...base, adapter: { ...ollamaAdapter, configSchema: { type: 'object' } }, config: {}, desired: { ...base.desired, replicas: '' } })
    expect(r).toEqual({ ok: true, body: { modelVersionId: 'v-1', providerType: 'ollama' } })
  })

  it('builds the full body with coerced numbers and ids, and leaves the pasted secret in without a connection', () => {
    const r = buildDeployBody({
      ...base,
      desired: { hardware: 'a10g', replicas: '2', minScale: '0', maxScale: '4', quantization: 'awq-int4', region: 'eu-west-1', privacyTier: 'private_cloud' },
      config: { baseUrl: 'http://gpu:11434', token: 'hf_secret', hourlyRateCents: '120' },
      budgetId: 'budget-1',
    })
    expect(r).toEqual({
      ok: true,
      body: {
        modelVersionId: 'v-1',
        providerType: 'ollama',
        desired: { replicas: 2, minScale: 0, maxScale: 4, hardware: 'a10g', region: 'eu-west-1', quantization: 'awq-int4', privacyTier: 'private_cloud' },
        providerConfig: { baseUrl: 'http://gpu:11434', token: 'hf_secret', hourlyRateCents: 120 },
        budgetId: 'budget-1',
      },
    })
  })

  it('strips the x-secret values and sends credentialId when a vault credential is chosen', () => {
    const r = buildDeployBody({ ...base, config: { baseUrl: 'http://gpu:11434', token: 'hf_secret', hourlyRateCents: '120' }, credentialId: 'cred-1' })
    expect(r).toEqual({
      ok: true,
      body: { modelVersionId: 'v-1', providerType: 'ollama', desired: { replicas: 1 }, providerConfig: { baseUrl: 'http://gpu:11434', hourlyRateCents: 120 }, credentialId: 'cred-1' },
    })
  })

  it('sends a connect-sheet connection as credentialId and no longer requires the schema secrets', () => {
    // hf requires apiToken; with a connection the token is neither required nor sent.
    const r = buildDeployBody({ ...base, adapter: hfAdapter, config: { namespace: 'acme' }, connectionId: 'conn-1' })
    expect(r).toEqual({ ok: true, body: { modelVersionId: 'v-1', providerType: 'huggingface-endpoints', desired: { replicas: 1 }, providerConfig: { namespace: 'acme' }, credentialId: 'conn-1' } })
    if (r.ok) expect(r.body).not.toHaveProperty('connectionId')
  })

  it('still requires the schema secret when nothing supplies it', () => {
    const r = buildDeployBody({ ...base, adapter: hfAdapter, config: { namespace: 'acme' } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors['config.apiToken']).toMatch(/required/)
  })
})

describe('describeBudget', () => {
  it('describes a budget by limit, period, scope and behaviour', () => {
    expect(describeBudget({ id: 'b', agentId: null, llmProviderId: null, periodType: 'month', limitCents: 50000, behavior: 'reject', active: true })).toBe('$500.00 per month (whole org, hard stop)')
    expect(describeBudget({ id: 'b', agentId: 'a', llmProviderId: null, periodType: 'day', limitCents: 100, behavior: 'warn_log', active: true })).toBe('$1.00 per day (one agent, warn)')
  })
})

describe('DeployDialog', () => {
  beforeEach(() => {
    mockedCredentials.mockReset().mockResolvedValue([{ id: 'cred-1', name: 'HF token', type: 'api_key', isActive: true, createdAt: '', organizationId: 'o' }])
    mockedBudgets.mockReset().mockResolvedValue([
      { id: 'budget-1', agentId: null, llmProviderId: null, periodType: 'month', limitCents: 50000, behavior: 'reject', active: true },
      { id: 'budget-old', agentId: null, llmProviderId: null, periodType: 'month', limitCents: 1, behavior: 'reject', active: false },
    ])
  })

  it('posts the right body from a schema with a secret', async () => {
    const onSubmit = vi.fn()
    render(<DeployDialog open onOpenChange={() => {}} adapters={[ollamaAdapter, hfAdapter]} versions={[makeVersion()]} onSubmit={onSubmit} />)

    // Adapter cards list capabilities.
    expect(screen.getAllByText('scale to zero', { selector: 'span' })).toHaveLength(2)
    expect(screen.getByText('2 regions')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: /Hugging Face Endpoints/ }))
    expect(screen.getByRole('radio', { name: /Hugging Face Endpoints/ })).toHaveAttribute('aria-checked', 'true')

    // The adapter's schema form appears with its secret as a password field.
    const token = screen.getByLabelText('API token')
    expect(token).toHaveAttribute('type', 'password')
    fireEvent.change(token, { target: { value: 'hf_live_123' } })
    fireEvent.change(screen.getByLabelText('Namespace'), { target: { value: 'acme' } })

    fireEvent.change(screen.getByLabelText('Version'), { target: { value: 'v-1' } })

    // Region comes from capabilities, quantization from the version.
    const region = screen.getByLabelText('Region') as HTMLSelectElement
    expect(Array.from(region.options).map((o) => o.value)).toEqual(['', 'us-east-1', 'eu-west-1'])
    fireEvent.change(region, { target: { value: 'eu-west-1' } })
    const quant = screen.getByLabelText('Quantization') as HTMLSelectElement
    expect(Array.from(quant.options).map((o) => o.value)).toEqual(['', 'bf16', 'awq-int4'])
    fireEvent.change(quant, { target: { value: 'awq-int4' } })

    fireEvent.change(screen.getByLabelText('Replicas'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('Hardware'), { target: { value: 'a10g' } })

    // No connection chosen: the inline path stays, with a hint towards a connection.
    expect(screen.getByTestId('deploy-secret-hint')).toHaveTextContent(/Recommended: connect the account/)
    // Inactive budgets are not offered.
    await waitFor(() => expect(screen.getByRole('option', { name: /per month/ })).toBeInTheDocument())
    const budget = screen.getByLabelText('Spend budget') as HTMLSelectElement
    expect(Array.from(budget.options).map((o) => o.value)).toEqual(['', 'budget-1'])
    fireEvent.change(budget, { target: { value: 'budget-1' } })

    fireEvent.click(screen.getByRole('button', { name: 'Deploy' }))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith({
      modelVersionId: 'v-1',
      providerType: 'huggingface-endpoints',
      desired: { replicas: 2, hardware: 'a10g', region: 'eu-west-1', quantization: 'awq-int4' },
      providerConfig: { apiToken: 'hf_live_123', namespace: 'acme' },
      budgetId: 'budget-1',
    })
  })

  it('hides the secret fields and sends only credentialId once a vault credential is picked', async () => {
    const onSubmit = vi.fn()
    render(<DeployDialog open onOpenChange={() => {}} adapters={[hfAdapter]} versions={[makeVersion()]} onSubmit={onSubmit} />)
    fireEvent.click(screen.getByRole('radio', { name: /Hugging Face Endpoints/ }))
    fireEvent.change(screen.getByLabelText('Version'), { target: { value: 'v-1' } })
    fireEvent.change(screen.getByLabelText('API token'), { target: { value: 'hf_typed' } })
    fireEvent.change(screen.getByLabelText('Namespace'), { target: { value: 'acme' } })

    await waitFor(() => expect(screen.getByRole('option', { name: 'HF token (api_key)' })).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Credential'), { target: { value: 'cred-1' } })

    // The x-secret field is gone from the form and the hint flips.
    expect(screen.queryByLabelText('API token')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Namespace')).toBeInTheDocument()
    expect(screen.getByTestId('deploy-secret-hint')).toHaveTextContent(/connection supplies the secret/)

    fireEvent.click(screen.getByRole('button', { name: 'Deploy' }))
    expect(onSubmit).toHaveBeenCalledWith({
      modelVersionId: 'v-1',
      providerType: 'huggingface-endpoints',
      desired: { replicas: 1 },
      providerConfig: { namespace: 'acme' },
      credentialId: 'cred-1',
    })
  })

  it('offers existing deployment connections and sends the picked one as credentialId', async () => {
    const onSubmit = vi.fn()
    render(<DeployDialog open onOpenChange={() => {}} adapters={[hfAdapter]} versions={[makeVersion()]} onSubmit={onSubmit} />)
    fireEvent.click(screen.getByRole('radio', { name: /Hugging Face Endpoints/ }))
    fireEvent.change(screen.getByLabelText('Version'), { target: { value: 'v-1' } })

    const select = (await screen.findByLabelText('Use an existing connection')) as HTMLSelectElement
    // Only the adapter's own connector is listed when it has a connection; the OpenAI key is not.
    await waitFor(() => expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'conn-hf']))
    fireEvent.change(select, { target: { value: 'conn-hf' } })

    expect(await screen.findByTestId('connected-chip')).toHaveTextContent('HF endpoints')
    expect(screen.queryByLabelText('API token')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Credential')).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Deploy' }))
    expect(onSubmit).toHaveBeenCalledWith({ modelVersionId: 'v-1', providerType: 'huggingface-endpoints', desired: { replicas: 1 }, credentialId: 'conn-hf' })
  })

  it('blocks submit and shows errors when the adapter, version or a required secret is missing', () => {
    const onSubmit = vi.fn()
    render(<DeployDialog open onOpenChange={() => {}} adapters={[hfAdapter]} versions={[makeVersion()]} onSubmit={onSubmit} />)
    fireEvent.click(screen.getByRole('button', { name: 'Deploy' }))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText('Pick an adapter')).toBeInTheDocument()
    expect(screen.getByText('Pick a version')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: /Hugging Face Endpoints/ }))
    fireEvent.change(screen.getByLabelText('Version'), { target: { value: 'v-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Deploy' }))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText('API token is required')).toBeInTheDocument()
  })

  it('seeds schema defaults when an adapter is picked and preselects a version', () => {
    render(<DeployDialog open onOpenChange={() => {}} adapters={[ollamaAdapter]} versions={[makeVersion()]} onSubmit={() => {}} initialVersionId="v-1" />)
    expect(screen.getByLabelText('Version')).toHaveValue('v-1')
    fireEvent.click(screen.getByRole('radio', { name: /Ollama/ }))
    expect(screen.getByLabelText('Ollama server URL')).toHaveValue('http://localhost:11434')
  })
})
