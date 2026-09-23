import { describe, it, expect } from 'vitest'

import { cloudAccountLabel, deploymentForCard, lineageFacts, modelSource, readableModelName, runsOn, unlistedDeployments } from '../model-hosting'
import { makeDeployment } from '@/components/models/hosting/__tests__/fixtures'

const providers = {
  p1: { id: 'p1', name: 'Anthropic prod', type: 'anthropic' },
  box: { id: 'box', name: 'Office box', type: 'custom', apiUrl: 'http://10.0.0.5:8000/v1' },
  ol: { id: 'ol', name: 'Laptop', type: 'ollama', apiUrl: 'http://localhost:11434' },
  managed: { id: 'managed', name: 'Support bot', type: 'openai' },
}

const card = (over: Record<string, any> = {}) => ({ id: 'c1', providerId: 'p1', providerType: 'anthropic', endpointRef: null, ...over }) as any

describe('modelSource', () => {
  it('tells the three places a model runs apart', () => {
    expect(modelSource(card())).toBe('provider')
    expect(modelSource(card({ providerId: 'box', providerType: 'custom' }))).toBe('server')
    expect(modelSource(card({ providerId: 'ol', providerType: 'ollama' }))).toBe('server')
    expect(modelSource(card({ providerId: null, providerType: null, endpointRef: { url: 'http://10.0.0.5:8000/v1' } }))).toBe('server')
    expect(modelSource(card({ endpointRef: { deploymentId: 'd-1', providerType: 'modal' } }))).toBe('cloud')
  })

  it('keeps a shut-down hosted model on your cloud, although its endpointRef was cleared', () => {
    // At teardown the reconcile loop nulls endpointRef and leaves the card
    // on the managed openai provider row; without the hosting record it
    // would read as "OpenAI API".
    const shutDown = card({ id: 'h1', providerId: 'managed', providerType: 'openai', endpointRef: null })
    const hosted = makeDeployment({ id: 'd-1', modelId: 'h1', providerType: 'huggingface-endpoints', state: 'torn_down' })
    expect(modelSource(shutDown)).toBe('provider')
    expect(modelSource(shutDown, hosted)).toBe('cloud')
    expect(runsOn(shutDown, providers, [], hosted)).toBe('Your Hugging Face account (Inference Endpoint)')
    expect(deploymentForCard(shutDown, [hosted])).toBe(hosted)
  })
})

describe('runsOn', () => {
  it('names the API, your server by host, or your cloud account', () => {
    expect(runsOn(card(), providers)).toBe('Anthropic API')
    expect(runsOn(card({ providerId: 'box', providerType: 'custom' }), providers)).toBe('Your server (10.0.0.5:8000)')
    expect(runsOn(card({ providerId: 'ol', providerType: 'ollama' }), providers)).toBe('Your Ollama server (localhost:11434)')
    expect(runsOn(card({ endpointRef: { deploymentId: 'd', providerType: 'aws-bedrock-import' } }), providers)).toBe('Your AWS account (Bedrock)')
    expect(runsOn(card({ providerId: null, providerType: null }), providers)).toBe('Not connected')
  })

  it('never says deployment for any cloud', () => {
    const keys = ['huggingface-endpoints', 'modal', 'aws-bedrock-import', 'sagemaker', 'vertex', 'azure-foundry', 'baseten', 'together', 'fireworks', 'nebius', 'runpod', 'digitalocean', 'ollama', 'stub', 'something-new']
    for (const key of keys) expect(cloudAccountLabel(key, [{ key: 'something-new', displayName: 'New Cloud' }])).not.toMatch(/deploy/i)
    expect(cloudAccountLabel('something-new', [{ key: 'something-new', displayName: 'New Cloud' }])).toBe('Your New Cloud account')
  })
})

describe('unlistedDeployments', () => {
  it('returns hosted models no card shows, and never shut-down ones', () => {
    const linked = makeDeployment({ id: 'd-1', modelId: 'c1', state: 'ready' })
    const byRef = makeDeployment({ id: 'd-2', modelId: null, state: 'ready' })
    const orphan = makeDeployment({ id: 'd-3', modelId: null, state: 'deploying' })
    const gone = makeDeployment({ id: 'd-4', modelId: null, state: 'torn_down' })
    const cards = [card({ id: 'c1' }), card({ id: 'c2', endpointRef: { deploymentId: 'd-2' } })]
    expect(unlistedDeployments(cards, [linked, byRef, orphan, gone]).map((d) => d.id)).toEqual(['d-3'])
  })
})

describe('readableModelName and lineageFacts', () => {
  it('reads a name out of a source', () => {
    expect(readableModelName('hf://meta-llama/Llama-3.1-8B-Instruct@abc')).toBe('Llama-3.1-8B-Instruct')
    expect(readableModelName('s3://bucket/weights/qwen3@etag')).toBe('qwen3')
    expect(readableModelName('')).toBe('Hosted model')
  })

  it('states lineage as plain facts', () => {
    expect(lineageFacts({ base: 'Llama 3.1 70B', quantization: '4-bit' })).toBe('Based on Llama 3.1 70B, 4-bit')
    expect(lineageFacts({})).toBeNull()
  })
})
