import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'

import { render } from '../../../../test/setup'
import { DeployDialog, buildDeployBody, describeBudget } from '../deploy-dialog'
import { bedrockAdapter, fireworksAdapter, hfAdapter, makeVersion, ollamaAdapter } from './fixtures'

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

describe('buildDeployBody', () => {
  const base = {
    adapter: ollamaAdapter,
    model: 'hf://acme/support-bot@e3b0c442',
    desired: EMPTY_DESIRED,
    config: { baseUrl: 'http://gpu:11434' },
    credentialId: '',
    budgetId: '',
  }

  it('sends the model as configuration, with no version anywhere in the body', () => {
    const r = buildDeployBody({ ...base, adapter: { ...ollamaAdapter, configSchema: { type: 'object' } }, config: {}, desired: { ...EMPTY_DESIRED, replicas: '' } })
    expect(r).toEqual({ ok: true, body: { model: 'hf://acme/support-bot@e3b0c442', providerType: 'ollama' } })
    if (r.ok) expect(r.body).not.toHaveProperty('modelVersionId')
  })

  it('needs a provider and a model', () => {
    const r = buildDeployBody({ ...base, adapter: null, model: '' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(Object.keys(r.errors).sort()).toEqual(['adapter', 'model'])
      expect(r.errors.model).toBe('Say where the model is')
    }
  })

  it('refuses a reference the grammar does not accept, before the request goes out', () => {
    const noPin = buildDeployBody({ ...base, model: 'hf://acme/support-bot' })
    expect(noPin.ok).toBe(false)
    if (!noPin.ok) expect(noPin.errors.model).toMatch(/needs an @pin/)

    const unknown = buildDeployBody({ ...base, model: 'ftp://acme/support-bot' })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.errors.model).toMatch(/Point at an artifact with a pin/)

    const traversal = buildDeployBody({ ...base, model: 'hf://acme/../secret@sha' })
    expect(traversal.ok).toBe(false)
    if (!traversal.ok) expect(traversal.errors.model).toMatch(/may not contain \.\./)
  })

  it('refuses a source the chosen provider cannot read, with the reason', () => {
    const r = buildDeployBody({ ...base, adapter: hfAdapter, model: 's3://weights/support@etag', config: { apiToken: 't' } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.model).toBe('Hugging Face Endpoints reads hf://, not s3://')
  })

  it('refuses a provider reference that names another platform', () => {
    const r = buildDeployBody({ ...base, adapter: hfAdapter, model: 'fireworks://accounts/acme/models/support', config: { apiToken: 't' } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.model).toMatch(/only that provider can run it/)
  })

  it('takes a provider reference with no pin, because the platform versions it', () => {
    const r = buildDeployBody({ ...base, adapter: fireworksAdapter, model: 'fireworks://accounts/acme/models/support', config: { accountId: 'acme' } })
    expect(r).toEqual({
      ok: true,
      body: { model: 'fireworks://accounts/acme/models/support', providerType: 'fireworks', desired: { replicas: 1 }, providerConfig: { accountId: 'acme' } },
    })
  })

  it('sends modelVersionId instead when an operator picked a tracked artifact, and drops base', () => {
    const r = buildDeployBody({ ...base, versionId: 'v-1', base: 'qwen3-14b', model: 'hf://acme/support-bot-v3@e3b0c442', config: { baseUrl: 'http://gpu:11434' } })
    expect(r).toEqual({
      ok: true,
      body: { modelVersionId: 'v-1', providerType: 'ollama', desired: { replicas: 1 }, providerConfig: { baseUrl: 'http://gpu:11434' } },
    })
    if (r.ok) expect(r.body).not.toHaveProperty('model')
  })

  it('sends base alongside a plain reference when the operator named one', () => {
    const r = buildDeployBody({ ...base, base: ' qwen3-14b ' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.body.base).toBe('qwen3-14b')
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
    const r = buildDeployBody({ ...base, desired: { ...EMPTY_DESIRED, replicas: '1.5', minScale: '3', maxScale: '1' } })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors.replicas).toMatch(/whole number/)
      expect(r.errors.maxScale).toMatch(/at least min scale/)
    }
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
        model: 'hf://acme/support-bot@e3b0c442',
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
      body: { model: 'hf://acme/support-bot@e3b0c442', providerType: 'ollama', desired: { replicas: 1 }, providerConfig: { baseUrl: 'http://gpu:11434', hourlyRateCents: 120 }, credentialId: 'cred-1' },
    })
  })

  it('sends a connect-sheet connection as credentialId and no longer requires the schema secrets', () => {
    const r = buildDeployBody({ ...base, adapter: hfAdapter, config: { namespace: 'acme' }, connectionId: 'conn-1' })
    expect(r).toEqual({
      ok: true,
      body: { model: 'hf://acme/support-bot@e3b0c442', providerType: 'huggingface-endpoints', desired: { replicas: 1 }, providerConfig: { namespace: 'acme' }, credentialId: 'conn-1' },
    })
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
  const allAdapters = [ollamaAdapter, hfAdapter, bedrockAdapter, fireworksAdapter]

  beforeEach(() => {
    mockedCredentials.mockReset().mockResolvedValue([{ id: 'cred-1', name: 'HF token', type: 'api_key', isActive: true, createdAt: '', organizationId: 'o' }])
    mockedBudgets.mockReset().mockResolvedValue([
      { id: 'budget-1', agentId: null, llmProviderId: null, periodType: 'month', limitCents: 50000, behavior: 'reject', active: true },
      { id: 'budget-old', agentId: null, llmProviderId: null, periodType: 'month', limitCents: 1, behavior: 'reject', active: false },
    ])
  })

  it('posts a body built from a model reference alone, with no version registered anywhere', async () => {
    const onSubmit = vi.fn()
    render(<DeployDialog open onOpenChange={() => {}} adapters={allAdapters} onSubmit={onSubmit} />)

    fireEvent.change(screen.getByLabelText('Where is the model?'), { target: { value: 'hf://Qwen/Qwen3-14B@abc123' } })
    // The field says what it understood, using the same grammar as the server.
    expect(screen.getByText('Hugging Face repo: Qwen/Qwen3-14B, pinned to abc123')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: /Hugging Face Endpoints/ }))
    fireEvent.change(screen.getByLabelText('API token'), { target: { value: 'hf_live_123' } })
    fireEvent.change(screen.getByLabelText('Namespace'), { target: { value: 'acme' } })

    const region = screen.getByLabelText('Region') as HTMLSelectElement
    expect(Array.from(region.options).map((o) => o.value)).toEqual(['', 'us-east-1', 'eu-west-1'])
    fireEvent.change(region, { target: { value: 'eu-west-1' } })
    fireEvent.change(screen.getByLabelText('Replicas'), { target: { value: '2' } })

    await waitFor(() => expect(screen.getByRole('option', { name: /per month/ })).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Spend budget'), { target: { value: 'budget-1' } })

    fireEvent.click(screen.getByRole('button', { name: 'Deploy' }))

    expect(onSubmit).toHaveBeenCalledWith({
      model: 'hf://Qwen/Qwen3-14B@abc123',
      providerType: 'huggingface-endpoints',
      desired: { replicas: 2, region: 'eu-west-1' },
      providerConfig: { apiToken: 'hf_live_123', namespace: 'acme' },
      budgetId: 'budget-1',
    })
  })

  it('offers only the providers that can run the model, and says why the rest cannot', () => {
    render(<DeployDialog open onOpenChange={() => {}} adapters={allAdapters} onSubmit={() => {}} />)

    // Nothing typed: every provider is on offer.
    expect(screen.getAllByRole('radio')).toHaveLength(4)

    fireEvent.change(screen.getByLabelText('Where is the model?'), { target: { value: 'hf://Qwen/Qwen3-14B@abc123' } })
    const offered = screen.getAllByRole('radio').map((el) => el.textContent)
    expect(offered).toHaveLength(2)
    expect(offered.join(' ')).toMatch(/Ollama/)
    expect(offered.join(' ')).toMatch(/Hugging Face Endpoints/)

    fireEvent.click(screen.getByRole('button', { name: /cannot run this model/ }))
    const blocked = screen.getByTestId('blocked-providers')
    expect(blocked).toHaveTextContent('Amazon Bedrock reads s3://, bedrock://, not hf://')
    expect(blocked).toHaveTextContent('Fireworks reads s3://, fireworks://, not hf://')
  })

  it('warns that a preview provider needs access before anything is created', () => {
    // Dedicated Inference is a DigitalOcean public preview. Saying so on
    // the card is the difference between a user knowing to opt in and a
    // user reading an opaque refusal after they have filled the form.
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
    render(<DeployDialog open onOpenChange={() => {}} adapters={[...allAdapters, preview]} onSubmit={() => {}} />)

    const card = screen.getByRole('radio', { name: /DigitalOcean/ })
    expect(card).toHaveTextContent('Public preview.')
    expect(card).toHaveTextContent('Feature Preview page')
    // A generally available provider says nothing of the sort.
    expect(screen.getByRole('radio', { name: /Hugging Face Endpoints/ })).not.toHaveTextContent('preview')
  })

  it('filters the other way: picking a provider narrows the sources on offer', () => {
    render(<DeployDialog open onOpenChange={() => {}} adapters={allAdapters} onSubmit={() => {}} />)

    fireEvent.click(screen.getByRole('radio', { name: /Amazon Bedrock/ }))
    expect(screen.getByTestId('adapter-accepts')).toHaveTextContent('Amazon Bedrock accepts s3://, bedrock://')
    const chips = screen.getByTestId('model-source-chips')
    expect(chips).toHaveTextContent('Amazon S3')
    expect(chips).toHaveTextContent('Amazon Bedrock')
    expect(chips).not.toHaveTextContent('Hugging Face repo')

    // A chip writes an example of that shape into the field.
    fireEvent.click(screen.getByRole('button', { name: 'Amazon S3' }))
    expect(screen.getByLabelText('Where is the model?')).toHaveValue('s3://bucket/prefix@etag')
  })

  it('blocks submit and explains an incompatible pair without asking the server', () => {
    const onSubmit = vi.fn()
    render(<DeployDialog open onOpenChange={() => {}} adapters={allAdapters} onSubmit={onSubmit} />)

    fireEvent.click(screen.getByRole('radio', { name: /Hugging Face Endpoints/ }))
    fireEvent.change(screen.getByLabelText('Where is the model?'), { target: { value: 's3://weights/support@etag' } })
    fireEvent.change(screen.getByLabelText('API token'), { target: { value: 'hf_live_123' } })
    // It leaves the offered list, so the form says where it went.
    expect(screen.getByTestId('dropped-selection')).toHaveTextContent('Hugging Face Endpoints is no longer on offer')

    fireEvent.click(screen.getByRole('button', { name: 'Deploy' }))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText('Hugging Face Endpoints reads hf://, not s3://')).toBeInTheDocument()
  })

  it('renders the server refusal with what the provider does accept', () => {
    render(
      <DeployDialog
        open
        onOpenChange={() => {}}
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
    render(<DeployDialog open onOpenChange={() => {}} adapters={[hfAdapter]} onSubmit={onSubmit} />)
    fireEvent.click(screen.getByRole('button', { name: 'Deploy' }))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText('Pick a provider')).toBeInTheDocument()
    expect(screen.getByText('Say where the model is')).toBeInTheDocument()
  })

  it('keeps registered versions out of the way, behind an optional section', () => {
    render(<DeployDialog open onOpenChange={() => {}} adapters={[ollamaAdapter]} versions={[makeVersion()]} onSubmit={() => {}} />)
    expect(screen.queryByLabelText('Registered version')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Tracked artifact/ }))
    const select = screen.getByLabelText('Registered version') as HTMLSelectElement
    expect(select).toHaveValue('')
    expect(screen.getByText(/Most deployments never use one/)).toBeInTheDocument()
  })

  it('fills the reference from a preselected version and submits it as modelVersionId', () => {
    const onSubmit = vi.fn()
    render(<DeployDialog open onOpenChange={() => {}} adapters={[ollamaAdapter]} versions={[makeVersion()]} initialVersionId="v-1" onSubmit={onSubmit} />)

    expect(screen.getByLabelText('Where is the model?')).toHaveValue('hf://acme/support-bot-v3@e3b0c442')
    expect(screen.getByLabelText('Registered version')).toHaveValue('v-1')

    fireEvent.click(screen.getByRole('radio', { name: /Ollama/ }))
    expect(screen.getByLabelText('Ollama server URL')).toHaveValue('http://localhost:11434')

    fireEvent.click(screen.getByRole('button', { name: 'Deploy' }))
    expect(onSubmit).toHaveBeenCalledWith({
      modelVersionId: 'v-1',
      providerType: 'ollama',
      desired: { replicas: 1 },
      providerConfig: { baseUrl: 'http://localhost:11434' },
    })
  })

  it('typing over the reference drops the version, so the model is plain configuration again', () => {
    const onSubmit = vi.fn()
    render(<DeployDialog open onOpenChange={() => {}} adapters={[ollamaAdapter]} versions={[makeVersion()]} initialVersionId="v-1" onSubmit={onSubmit} />)

    fireEvent.change(screen.getByLabelText('Where is the model?'), { target: { value: 'hf://Qwen/Qwen3-14B@abc123' } })
    expect(screen.getByLabelText('Registered version')).toHaveValue('')

    fireEvent.click(screen.getByRole('radio', { name: /Ollama/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Deploy' }))
    expect(onSubmit).toHaveBeenCalledWith({
      model: 'hf://Qwen/Qwen3-14B@abc123',
      providerType: 'ollama',
      desired: { replicas: 1 },
      providerConfig: { baseUrl: 'http://localhost:11434' },
    })
  })

  it('hides the secret fields and sends only credentialId once a vault credential is picked', async () => {
    const onSubmit = vi.fn()
    render(<DeployDialog open onOpenChange={() => {}} adapters={[hfAdapter]} onSubmit={onSubmit} />)
    fireEvent.change(screen.getByLabelText('Where is the model?'), { target: { value: 'hf://Qwen/Qwen3-14B@abc123' } })
    fireEvent.click(screen.getByRole('radio', { name: /Hugging Face Endpoints/ }))
    fireEvent.change(screen.getByLabelText('API token'), { target: { value: 'hf_typed' } })
    fireEvent.change(screen.getByLabelText('Namespace'), { target: { value: 'acme' } })

    await waitFor(() => expect(screen.getByRole('option', { name: 'HF token (api_key)' })).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Credential'), { target: { value: 'cred-1' } })

    expect(screen.queryByLabelText('API token')).not.toBeInTheDocument()
    expect(screen.getByTestId('deploy-secret-hint')).toHaveTextContent(/connection supplies the secret/)

    fireEvent.click(screen.getByRole('button', { name: 'Deploy' }))
    expect(onSubmit).toHaveBeenCalledWith({
      model: 'hf://Qwen/Qwen3-14B@abc123',
      providerType: 'huggingface-endpoints',
      desired: { replicas: 1 },
      providerConfig: { namespace: 'acme' },
      credentialId: 'cred-1',
    })
  })

  it('offers existing deployment connections and sends the picked one as credentialId', async () => {
    const onSubmit = vi.fn()
    render(<DeployDialog open onOpenChange={() => {}} adapters={[hfAdapter]} onSubmit={onSubmit} />)
    fireEvent.change(screen.getByLabelText('Where is the model?'), { target: { value: 'hf://Qwen/Qwen3-14B@abc123' } })
    fireEvent.click(screen.getByRole('radio', { name: /Hugging Face Endpoints/ }))

    const select = (await screen.findByLabelText('Use an existing connection')) as HTMLSelectElement
    await waitFor(() => expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'conn-hf']))
    fireEvent.change(select, { target: { value: 'conn-hf' } })

    expect(await screen.findByTestId('connected-chip')).toHaveTextContent('HF endpoints')
    expect(screen.queryByLabelText('API token')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Deploy' }))
    expect(onSubmit).toHaveBeenCalledWith({
      model: 'hf://Qwen/Qwen3-14B@abc123',
      providerType: 'huggingface-endpoints',
      desired: { replicas: 1 },
      credentialId: 'conn-hf',
    })
  })
})
