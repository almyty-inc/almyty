import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'

import { render } from '../../../../test/setup'
import { DeployDialog, buildDeployBody, describeBudget } from '../deploy-dialog'
import { hfAdapter, makeVersion, ollamaAdapter } from './fixtures'

vi.mock('../../../../lib/api', () => ({
  credentialsApi: { getAll: vi.fn() },
  budgetsApi: { list: vi.fn() },
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

  it('builds the full body with coerced numbers, secret and ids', () => {
    const r = buildDeployBody({
      ...base,
      desired: { hardware: 'a10g', replicas: '2', minScale: '0', maxScale: '4', quantization: 'awq-int4', region: 'eu-west-1', privacyTier: 'private_cloud' },
      config: { baseUrl: 'http://gpu:11434', token: 'hf_secret', hourlyRateCents: '120' },
      credentialId: 'cred-1',
      budgetId: 'budget-1',
    })
    expect(r).toEqual({
      ok: true,
      body: {
        modelVersionId: 'v-1',
        providerType: 'ollama',
        desired: { replicas: 2, minScale: 0, maxScale: 4, hardware: 'a10g', region: 'eu-west-1', quantization: 'awq-int4', privacyTier: 'private_cloud' },
        providerConfig: { baseUrl: 'http://gpu:11434', token: 'hf_secret', hourlyRateCents: 120 },
        credentialId: 'cred-1',
        budgetId: 'budget-1',
      },
    })
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

    await waitFor(() => expect(screen.getByRole('option', { name: 'HF token (api_key)' })).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Credential'), { target: { value: 'cred-1' } })
    // Inactive budgets are not offered.
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
      credentialId: 'cred-1',
      budgetId: 'budget-1',
    })
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
