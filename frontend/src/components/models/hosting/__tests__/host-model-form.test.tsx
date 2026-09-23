import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'

import { render } from '../../../../test/setup'
import { HostModelForm, buildHostBody, describeBudget } from '../host-model-form'
import { bedrockAdapter, fireworksAdapter, hfAdapter, ollamaAdapter } from './fixtures'
import type { ModelAdapter } from '@/types/deployments'

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

const EMPTY_DESIRED = { hardware: '', replicas: '1', minScale: '', maxScale: '', quantization: '', region: '', privacyTier: '' as const }

/** Watches a server someone else runs; in the UI that is "A server you run", never a cloud. */
const customEndpointAdapter: ModelAdapter = {
  key: 'custom-endpoint',
  displayName: 'OpenAI-compatible endpoint (managed elsewhere)',
  capabilities: { architectures: 'any', lora: 'none', serverless: false, dedicated: false, scaleToZero: false, regions: [], registrySources: ['hub', 'local'] },
  modelSchemes: ['hf://', 'file://'],
  configSchema: { type: 'object', properties: { url: { type: 'string', title: 'Base URL' } }, required: ['url'] },
}

describe('buildHostBody', () => {
  const base = {
    adapter: ollamaAdapter,
    model: 'hf://acme/support-bot@e3b0c442',
    desired: EMPTY_DESIRED,
    config: { baseUrl: 'http://gpu:11434' },
    credentialId: '',
    budgetId: '',
  }

  it('sends the model as configuration, with no version anywhere in the body', () => {
    const r = buildHostBody({ ...base, adapter: { ...ollamaAdapter, configSchema: { type: 'object' } }, config: {}, desired: { ...EMPTY_DESIRED, replicas: '' } })
    expect(r).toEqual({ ok: true, body: { model: 'hf://acme/support-bot@e3b0c442', providerType: 'ollama' } })
    if (r.ok) expect(r.body).not.toHaveProperty('modelVersionId')
  })

  it('takes a Hugging Face repository with no commit: the server pins it', () => {
    const r = buildHostBody({ ...base, model: 'hf://Qwen/Qwen3-14B' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.body.model).toBe('hf://Qwen/Qwen3-14B')
  })

  it('sends the name when one is given', () => {
    const r = buildHostBody({ ...base, name: '  Support bot  ' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.body.name).toBe('Support bot')
    const unnamed = buildHostBody(base)
    if (unnamed.ok) expect(unnamed.body).not.toHaveProperty('name')
  })

  it('needs a cloud and a model', () => {
    const r = buildHostBody({ ...base, adapter: null, model: '' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(Object.keys(r.errors).sort()).toEqual(['adapter', 'model'])
      expect(r.errors.model).toBe('Say which model to run')
      expect(r.errors.adapter).toBe('Pick the cloud that runs it')
    }
  })

  it('refuses a source the grammar does not accept, before the request goes out', () => {
    const noPin = buildHostBody({ ...base, model: 's3://weights/support' })
    expect(noPin.ok).toBe(false)
    if (!noPin.ok) expect(noPin.errors.model).toMatch(/needs an @pin/)

    const unknown = buildHostBody({ ...base, model: 'ftp://acme/support-bot' })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.errors.model).toMatch(/Name a Hugging Face repository/)

    const traversal = buildHostBody({ ...base, model: 'hf://acme/../secret@sha' })
    expect(traversal.ok).toBe(false)
    if (!traversal.ok) expect(traversal.errors.model).toMatch(/may not contain \.\./)
  })

  it('refuses a source the chosen cloud cannot read, with the reason', () => {
    const r = buildHostBody({ ...base, adapter: hfAdapter, model: 's3://weights/support@etag', config: { apiToken: 't' } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.model).toBe('Hugging Face Endpoints reads hf://, not s3://')
  })

  it('refuses a platform reference that names another cloud', () => {
    const r = buildHostBody({ ...base, adapter: hfAdapter, model: 'fireworks://accounts/acme/models/support', config: { apiToken: 't' } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.model).toMatch(/only that cloud can run it/)
  })

  it('takes a platform reference with no pin, because the platform versions it', () => {
    const r = buildHostBody({ ...base, adapter: fireworksAdapter, model: 'fireworks://accounts/acme/models/support', config: { accountId: 'acme' } })
    expect(r).toEqual({
      ok: true,
      body: { model: 'fireworks://accounts/acme/models/support', providerType: 'fireworks', desired: { replicas: 1 }, providerConfig: { accountId: 'acme' } },
    })
  })

  it('sends base alongside the source when one was named', () => {
    const r = buildHostBody({ ...base, base: ' qwen3-14b ' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.body.base).toBe('qwen3-14b')
  })

  it('carries the schema errors under config.*', () => {
    const r = buildHostBody({ ...base, config: { baseUrl: '', hourlyRateCents: 'x' } })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors['config.baseUrl']).toMatch(/required/)
      expect(r.errors['config.hourlyRateCents']).toMatch(/number/)
    }
  })

  it('rejects fractional copies and min above max', () => {
    const r = buildHostBody({ ...base, desired: { ...EMPTY_DESIRED, replicas: '1.5', minScale: '3', maxScale: '1' } })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors.replicas).toMatch(/whole number/)
      expect(r.errors.maxScale).toMatch(/at least min copies/)
    }
  })

  it('builds the full body with coerced numbers and ids, and leaves the pasted secret in without a connection', () => {
    const r = buildHostBody({
      ...base,
      desired: { hardware: 'a10g', replicas: '2', minScale: '0', maxScale: '4', quantization: 'awq-int4', region: 'eu-west-1', privacyTier: 'private_cloud' },
      config: { baseUrl: 'http://gpu:11434', token: 'hf_secret', hourlyRateCents: '120' },
      budgetId: 'budget-1',
    })
    expect(r).toEqual({
      ok: true,
      body: {
        model: 'hf://acme/support-bot@e3b0c442',
        providerType: 'ollama',
        desired: { replicas: 2, minScale: 0, maxScale: 4, hardware: 'a10g', region: 'eu-west-1', quantization: 'awq-int4', privacyTier: 'private_cloud' },
        providerConfig: { baseUrl: 'http://gpu:11434', token: 'hf_secret', hourlyRateCents: 120 },
        budgetId: 'budget-1',
      },
    })
  })

  it('strips the x-secret values and sends credentialId when a vault credential is chosen', () => {
    const r = buildHostBody({ ...base, config: { baseUrl: 'http://gpu:11434', token: 'hf_secret', hourlyRateCents: '120' }, credentialId: 'cred-1' })
    expect(r).toEqual({
      ok: true,
      body: { model: 'hf://acme/support-bot@e3b0c442', providerType: 'ollama', desired: { replicas: 1 }, providerConfig: { baseUrl: 'http://gpu:11434', hourlyRateCents: 120 }, credentialId: 'cred-1' },
    })
  })

  it('sends a connect-sheet connection as credentialId and no longer requires the schema secrets', () => {
    const r = buildHostBody({ ...base, adapter: hfAdapter, config: { namespace: 'acme' }, connectionId: 'conn-1' })
    expect(r).toEqual({
      ok: true,
      body: { model: 'hf://acme/support-bot@e3b0c442', providerType: 'huggingface-endpoints', desired: { replicas: 1 }, providerConfig: { namespace: 'acme' }, credentialId: 'conn-1' },
    })
    if (r.ok) expect(r.body).not.toHaveProperty('connectionId')
  })

  it('still requires the schema secret when nothing supplies it', () => {
    const r = buildHostBody({ ...base, adapter: hfAdapter, config: { namespace: 'acme' } })
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

describe('HostModelForm', () => {
  const allAdapters = [ollamaAdapter, hfAdapter, bedrockAdapter, fireworksAdapter]

  beforeEach(() => {
    mockedCredentials.mockReset().mockResolvedValue([{ id: 'cred-1', name: 'HF token', type: 'api_key', isActive: true, createdAt: '', organizationId: 'o' }])
    mockedBudgets.mockReset().mockResolvedValue([
      { id: 'budget-1', agentId: null, llmProviderId: null, periodType: 'month', limitCents: 50000, behavior: 'reject', active: true },
      { id: 'budget-old', agentId: null, llmProviderId: null, periodType: 'month', limitCents: 1, behavior: 'reject', active: false },
    ])
  })

  it('posts a body built from a Hugging Face repository alone, with a spending cap', async () => {
    const onSubmit = vi.fn()
    render(<HostModelForm adapters={allAdapters} onSubmit={onSubmit} />)

    fireEvent.change(screen.getByLabelText('Which model'), { target: { value: 'hf://Qwen/Qwen3-14B' } })
    // No commit typed: the field says the server pins it.
    expect(screen.getByText('Hugging Face repo: Qwen/Qwen3-14B, pinned to its exact commit when you save')).toBeInTheDocument()
    // The name defaults to the repository name.
    expect(screen.getByLabelText(/^Name/)).toHaveAttribute('placeholder', 'Qwen3-14B')

    fireEvent.click(screen.getByRole('radio', { name: /Hugging Face Inference Endpoints/ }))
    fireEvent.change(screen.getByLabelText('API token'), { target: { value: 'hf_live_123' } })
    fireEvent.change(screen.getByLabelText('Namespace'), { target: { value: 'acme' } })

    const region = screen.getByLabelText('Region') as HTMLSelectElement
    expect(Array.from(region.options).map((o) => o.value)).toEqual(['', 'us-east-1', 'eu-west-1'])
    fireEvent.change(region, { target: { value: 'eu-west-1' } })
    fireEvent.change(screen.getByLabelText('Copies'), { target: { value: '2' } })

    await waitFor(() => expect(screen.getByRole('option', { name: /per month/ })).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Spending cap'), { target: { value: 'budget-1' } })

    fireEvent.click(screen.getByRole('button', { name: 'Host model' }))

    expect(onSubmit).toHaveBeenCalledWith({
      model: 'hf://Qwen/Qwen3-14B',
      providerType: 'huggingface-endpoints',
      desired: { replicas: 2, region: 'eu-west-1', privacyTier: 'private_cloud' },
      providerConfig: { apiToken: 'hf_live_123', namespace: 'acme' },
      budgetId: 'budget-1',
    })
  })

  it('never offers the watch-a-server integration as a cloud', () => {
    render(<HostModelForm adapters={[...allAdapters, customEndpointAdapter]} onSubmit={() => {}} />)
    expect(screen.getAllByRole('radio')).toHaveLength(4)
    expect(screen.queryByRole('radio', { name: /OpenAI-compatible/ })).not.toBeInTheDocument()
  })

  it('never says deployment or tracked artifact to the user', () => {
    const { container } = render(<HostModelForm adapters={allAdapters} onSubmit={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /More options/ }))
    expect(container.textContent ?? '').not.toMatch(/deploy|tracked artifact|registered version/i)
  })

  it('offers only the clouds that can run the model, and says why the rest cannot', () => {
    render(<HostModelForm adapters={allAdapters} onSubmit={() => {}} />)

    expect(screen.getAllByRole('radio')).toHaveLength(4)

    fireEvent.change(screen.getByLabelText('Which model'), { target: { value: 'hf://Qwen/Qwen3-14B@abc123' } })
    const offered = screen.getAllByRole('radio').map((el) => el.textContent)
    expect(offered).toHaveLength(2)
    expect(offered.join(' ')).toMatch(/Ollama/)
    expect(offered.join(' ')).toMatch(/Hugging Face Inference Endpoints/)

    fireEvent.click(screen.getByRole('button', { name: /cannot run this model/ }))
    const blocked = screen.getByTestId('blocked-providers')
    expect(blocked).toHaveTextContent('Amazon Bedrock reads s3://, bedrock://, not hf://')
    expect(blocked).toHaveTextContent('Fireworks reads s3://, fireworks://, not hf://')
  })

  it('warns that a preview cloud needs access before anything is created', () => {
    const preview = {
      ...hfAdapter,
      key: 'digitalocean',
      displayName: 'DigitalOcean Gradient AI',
      modelSchemes: ['hf://'],
      capabilities: {
        ...hfAdapter.capabilities,
        availability: 'public_preview' as const,
        availabilityNote: 'Dedicated Inference is a DigitalOcean public preview: enable it from the Feature Preview page in your control panel first.',
      },
    }
    render(<HostModelForm adapters={[...allAdapters, preview]} onSubmit={() => {}} />)

    const card = screen.getByRole('radio', { name: /DigitalOcean/ })
    expect(card).toHaveTextContent('Public preview.')
    expect(card).toHaveTextContent('Feature Preview page')
    expect(screen.getByRole('radio', { name: /Hugging Face Inference Endpoints/ })).not.toHaveTextContent('preview')
  })

  it('filters the other way: picking a cloud narrows the sources on offer', () => {
    render(<HostModelForm adapters={allAdapters} onSubmit={() => {}} />)

    fireEvent.click(screen.getByRole('radio', { name: /AWS Bedrock/ }))
    expect(screen.getByTestId('adapter-accepts')).toHaveTextContent('AWS Bedrock accepts s3://, bedrock://')
    const chips = screen.getByTestId('model-source-chips')
    expect(chips).toHaveTextContent('Amazon S3')
    expect(chips).toHaveTextContent('Amazon Bedrock')
    expect(chips).not.toHaveTextContent('Hugging Face repo')

    fireEvent.click(screen.getByRole('button', { name: 'Amazon S3' }))
    expect(screen.getByLabelText('Which model')).toHaveValue('s3://bucket/prefix@etag')
  })

  it('blocks submit and explains an incompatible pair without asking the server', () => {
    const onSubmit = vi.fn()
    render(<HostModelForm adapters={allAdapters} onSubmit={onSubmit} />)

    fireEvent.click(screen.getByRole('radio', { name: /Hugging Face Inference Endpoints/ }))
    fireEvent.change(screen.getByLabelText('Which model'), { target: { value: 's3://weights/support@etag' } })
    fireEvent.change(screen.getByLabelText('API token'), { target: { value: 'hf_live_123' } })
    expect(screen.getByTestId('dropped-selection')).toHaveTextContent('Hugging Face Inference Endpoints is no longer on offer')

    fireEvent.click(screen.getByRole('button', { name: 'Host model' }))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText('Hugging Face Endpoints reads hf://, not s3://')).toBeInTheDocument()
  })

  it('renders the server refusal with what the cloud does accept', () => {
    render(
      <HostModelForm
        adapters={allAdapters}
        onSubmit={() => {}}
        refusal={{ code: 'ADAPTER_UNSUPPORTED_SOURCE', message: 'Amazon Bedrock cannot run hf://Qwen/Qwen3-14B@abc: this provider reads s3://', accepts: ['s3://', 'bedrock://'] }}
      />,
    )
    const refusal = screen.getByTestId('adapter-refusal')
    expect(refusal).toHaveTextContent('Amazon Bedrock cannot run hf://Qwen/Qwen3-14B@abc')
    expect(refusal).toHaveTextContent('It accepts s3://, bedrock://.')
  })

  it('blocks submit and names both missing answers', () => {
    const onSubmit = vi.fn()
    render(<HostModelForm adapters={[hfAdapter]} onSubmit={onSubmit} />)
    fireEvent.click(screen.getByRole('button', { name: 'Host model' }))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText('Pick the cloud that runs it')).toBeInTheDocument()
    expect(screen.getByText('Say which model to run')).toBeInTheDocument()
  })

  it('hides the secret fields and sends only credentialId once a saved credential is picked', async () => {
    const onSubmit = vi.fn()
    render(<HostModelForm adapters={[hfAdapter]} onSubmit={onSubmit} />)
    fireEvent.change(screen.getByLabelText('Which model'), { target: { value: 'hf://Qwen/Qwen3-14B@abc123' } })
    fireEvent.click(screen.getByRole('radio', { name: /Hugging Face Inference Endpoints/ }))
    fireEvent.change(screen.getByLabelText('API token'), { target: { value: 'hf_typed' } })
    fireEvent.change(screen.getByLabelText('Namespace'), { target: { value: 'acme' } })

    await waitFor(() => expect(screen.getByRole('option', { name: 'HF token (api_key)' })).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Saved credential'), { target: { value: 'cred-1' } })

    expect(screen.queryByLabelText('API token')).not.toBeInTheDocument()
    expect(screen.getByTestId('host-secret-hint')).toHaveTextContent(/connected account supplies the secret/)

    fireEvent.click(screen.getByRole('button', { name: 'Host model' }))
    expect(onSubmit).toHaveBeenCalledWith({
      model: 'hf://Qwen/Qwen3-14B@abc123',
      providerType: 'huggingface-endpoints',
      desired: { replicas: 1, privacyTier: 'private_cloud' },
      providerConfig: { namespace: 'acme' },
      credentialId: 'cred-1',
    })
  })

  it('offers existing cloud connections and sends the picked one as credentialId', async () => {
    const onSubmit = vi.fn()
    render(<HostModelForm adapters={[hfAdapter]} onSubmit={onSubmit} />)
    fireEvent.change(screen.getByLabelText('Which model'), { target: { value: 'hf://Qwen/Qwen3-14B@abc123' } })
    fireEvent.click(screen.getByRole('radio', { name: /Hugging Face Inference Endpoints/ }))

    const select = (await screen.findByLabelText('Use an existing connection')) as HTMLSelectElement
    await waitFor(() => expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'conn-hf']))
    fireEvent.change(select, { target: { value: 'conn-hf' } })

    expect(await screen.findByTestId('connected-chip')).toHaveTextContent('HF endpoints')
    expect(screen.queryByLabelText('API token')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Host model' }))
    expect(onSubmit).toHaveBeenCalledWith({
      model: 'hf://Qwen/Qwen3-14B@abc123',
      providerType: 'huggingface-endpoints',
      desired: { replicas: 1, privacyTier: 'private_cloud' },
      credentialId: 'conn-hf',
    })
  })
})
