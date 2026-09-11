import { describe, it, expect } from 'vitest'

import {
  adapterAccepts,
  adapterSchemes,
  deploymentModelRef,
  describeModelRef,
  matchAdapters,
  parseModelRef,
  readAdapterRefusal,
  runnableAdapters,
  schemeOf,
} from '@/lib/deployments-api'
import { bedrockAdapter, fireworksAdapter, hfAdapter, makeDeployment, makeVersion, ollamaAdapter } from '@/components/models/deployments/__tests__/fixtures'

/**
 * The grammar has to match backend/src/modules/model-registry/registry-uri.ts
 * exactly, or the form and the server disagree about what is valid.
 */
describe('parseModelRef', () => {
  it('reads an artifact reference and splits its parts', () => {
    expect(parseModelRef('hf://Qwen/Qwen3-14B@abc123')).toEqual({
      ok: true,
      value: { scheme: 'hf', kind: 'artifact', location: 'Qwen/Qwen3-14B', prefix: '', pin: 'abc123', raw: 'hf://Qwen/Qwen3-14B@abc123' },
    })
    expect(parseModelRef('s3://registry/qwen3-14b@e3b0c442')).toEqual({
      ok: true,
      value: { scheme: 's3', kind: 'artifact', location: 'registry', prefix: 'qwen3-14b', pin: 'e3b0c442', raw: 's3://registry/qwen3-14b@e3b0c442' },
    })
    expect(parseModelRef('gs://bucket/models/qwen@17')).toEqual({
      ok: true,
      value: { scheme: 'gs', kind: 'artifact', location: 'bucket', prefix: 'models/qwen', pin: '17', raw: 'gs://bucket/models/qwen@17' },
    })
    expect(parseModelRef(' file:///models/qwen@sha256:ff ')).toEqual({
      ok: true,
      value: { scheme: 'file', kind: 'artifact', location: '/models/qwen', prefix: '', pin: 'sha256:ff', raw: 'file:///models/qwen@sha256:ff' },
    })
  })

  it('takes a provider reference without a pin, because the platform versions it', () => {
    expect(parseModelRef('fireworks://accounts/acme/models/support')).toEqual({
      ok: true,
      value: { scheme: 'fireworks', kind: 'provider', location: 'accounts/acme/models/support', prefix: '', pin: '', raw: 'fireworks://accounts/acme/models/support' },
    })
    expect(parseModelRef('bedrock://arn:aws:bedrock:us-east-1:1:model/x').ok).toBe(true)
    expect(parseModelRef('together://acme/support').ok).toBe(true)
    expect(parseModelRef('baseten://abcd1234').ok).toBe(true)
    expect(parseModelRef('vertex://publishers/google/models/gemma').ok).toBe(true)
    expect(parseModelRef('sagemaker://model-package/arn:aws:sagemaker:x').ok).toBe(true)
    expect(parseModelRef('azureml://registries/r/models/m/labels/latest').ok).toBe(true)
  })

  it('reads a pin off a provider reference that carries one', () => {
    const r = parseModelRef('foundry://onnx/phi-3@2')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.pin).toBe('2')
  })

  it('insists on a pin for an artifact, since the reference has to be immutable', () => {
    const r = parseModelRef('hf://Qwen/Qwen3-14B')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/needs an @pin/)
  })

  it('refuses traversal, relative file paths, bad hub ids, unknown schemes and an empty value', () => {
    expect(parseModelRef('s3://bucket/../x@1').ok).toBe(false)
    expect(parseModelRef('fireworks://accounts/../x').ok).toBe(false)
    expect(parseModelRef('file://models/x@1').ok).toBe(false)
    expect(parseModelRef('hf://onlyorg@1').ok).toBe(false)
    expect(parseModelRef('ftp://bucket/x@1').ok).toBe(false)
    expect(parseModelRef('').ok).toBe(false)
    expect(parseModelRef('fireworks://').ok).toBe(false)
  })

  it('names the scheme even while the rest of the reference is still being typed', () => {
    expect(schemeOf('hf://half')).toBe('hf')
    expect(schemeOf('bedrock://')).toBe('bedrock')
    expect(schemeOf('nonsense')).toBe(null)
    expect(schemeOf('ftp://x')).toBe(null)
  })

  it('describes what it understood, for the field helper', () => {
    const artifact = parseModelRef('s3://registry/qwen@e3b0')
    if (artifact.ok) expect(describeModelRef(artifact.value)).toBe('Amazon S3: registry/qwen, pinned to e3b0')
    const provider = parseModelRef('together://acme/support')
    if (provider.ok) expect(describeModelRef(provider.value)).toBe('Together: acme/support')
  })
})

describe('adapter matching', () => {
  const adapters = [ollamaAdapter, hfAdapter, bedrockAdapter, fireworksAdapter]

  it('reads the schemes an adapter declares', () => {
    expect(adapterSchemes(bedrockAdapter)).toEqual(['s3', 'bedrock'])
    expect(adapterAccepts(hfAdapter, 'hf')).toBe(true)
    expect(adapterAccepts(hfAdapter, 's3')).toBe(false)
    expect(adapterAccepts(hfAdapter, null)).toBe(false)
    expect(adapterSchemes({ modelSchemes: undefined })).toEqual([])
  })

  it('picks the providers that can run a hub model and explains the rest', () => {
    expect(runnableAdapters(adapters, 'hf').map((a) => a.key)).toEqual(['ollama', 'huggingface-endpoints'])
    const blocked = matchAdapters(adapters, 'hf').filter((m) => !m.ok)
    expect(blocked.map((m) => m.reason)).toEqual([
      'Amazon Bedrock reads s3://, bedrock://, not hf://',
      'Fireworks reads s3://, fireworks://, not hf://',
    ])
  })

  it('gives a provider reference to the one platform that owns it', () => {
    expect(runnableAdapters(adapters, 'fireworks').map((a) => a.key)).toEqual(['fireworks'])
    const blocked = matchAdapters(adapters, 'fireworks').filter((m) => !m.ok)
    expect(blocked[0].reason).toBe('fireworks:// names a model on Fireworks, and only that provider can run it')
  })

  it('offers everything while no model is named, so the picker can filter the other way', () => {
    expect(runnableAdapters(adapters, null)).toHaveLength(4)
  })
})

describe('readAdapterRefusal', () => {
  /**
   * The server wraps every error as `{ error: { code, message, ... } }`.
   * These tests used the flat shape, which nothing ever sends, so they
   * passed while the refusal panel was dead against a live server. The
   * wrapped shape is the real one and is asserted first.
   */
  it('lifts the message and the accepted schemes off the wrapped 400 the server actually sends', () => {
    const err = {
      response: {
        data: {
          error: {
            code: 'ADAPTER_UNSUPPORTED_SOURCE',
            message: 'Amazon Bedrock cannot run hf://x@1',
            accepts: ['s3://', 'bedrock://'],
            statusCode: 400,
            timestamp: '2026-09-09T00:00:00.000Z',
            path: '/model-deployments',
          },
        },
      },
    }
    expect(readAdapterRefusal(err)).toEqual({ code: 'ADAPTER_UNSUPPORTED_SOURCE', message: 'Amazon Bedrock cannot run hf://x@1', accepts: ['s3://', 'bedrock://'] })
  })

  it('still reads a flat body, for a handler that answers without the filter', () => {
    const err = { response: { data: { code: 'ADAPTER_UNSUPPORTED_SOURCE', message: 'Amazon Bedrock cannot run hf://x@1', accepts: ['s3://'] } } }
    expect(readAdapterRefusal(err)).toEqual({ code: 'ADAPTER_UNSUPPORTED_SOURCE', message: 'Amazon Bedrock cannot run hf://x@1', accepts: ['s3://'] })
  })

  it('keeps the other model errors that have no accepts list', () => {
    expect(readAdapterRefusal({ response: { data: { error: { code: 'MODEL_REQUIRED', message: 'Name the model to run' } } } })).toEqual({
      code: 'MODEL_REQUIRED',
      message: 'Name the model to run',
      accepts: [],
    })
    expect(readAdapterRefusal({ response: { data: { error: { code: 'REGISTRY_URI_INVALID', message: 'registryUri must be an artifact with a pin' } } } })).toMatchObject({
      code: 'REGISTRY_URI_INVALID',
    })
  })

  it('ignores anything that is not a model refusal', () => {
    expect(readAdapterRefusal(new Error('network down'))).toBeNull()
    expect(readAdapterRefusal({ response: { data: { error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } } } })).toBeNull()
    expect(readAdapterRefusal({ response: { data: { error: {} } } })).toBeNull()
    expect(readAdapterRefusal({ response: { data: {} } })).toBeNull()
  })
})

describe('deploymentModelRef', () => {
  it('prefers the reference on the deployment, since most deployments only have one', () => {
    expect(deploymentModelRef(makeDeployment())).toBe('hf://acme/support-bot-v3@e3b0c442')
  })

  it('falls back to the registered version for the operator path', () => {
    const d = makeDeployment({ modelRef: null, modelVersionId: 'v-1' })
    expect(deploymentModelRef(d, [makeVersion()])).toBe('hf://acme/support-bot-v3@e3b0c442')
  })
})
