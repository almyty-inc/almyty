/**
 * The POST /model-deployments body behind "Start a model": the model is
 * configuration, compatibility is checked before the request goes out, and
 * a connected account's secrets are never sent.
 */
import { describe, it, expect } from 'vitest'

import { buildHostBody, describeBudget } from '../host-body'
import { fireworksAdapter, hfAdapter, ollamaAdapter } from './fixtures'

const EMPTY_DESIRED = { hardware: '', replicas: '1', minScale: '', maxScale: '', quantization: '', region: '', privacyTier: '' as const }

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
