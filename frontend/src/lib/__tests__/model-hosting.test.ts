import { describe, it, expect } from 'vitest'

import { cloudAccountLabel, deploymentForCard, lineageFacts, readableModelName, unlistedDeployments } from '../model-hosting'
import { makeDeployment } from '@/components/models/hosting/__tests__/fixtures'

const card = (over: Record<string, any> = {}) => ({ id: 'c1', providerId: 'p1', providerType: 'anthropic', endpointRef: null, ...over }) as any

describe('deploymentForCard', () => {
  it('finds the hosted model behind a card, even after its endpointRef was cleared at shut down', () => {
    // At teardown the reconcile loop nulls endpointRef; the hosting record
    // still names the card.
    const shutDown = card({ id: 'h1', providerId: 'managed', providerType: 'openai', endpointRef: null })
    const hosted = makeDeployment({ id: 'd-1', modelId: 'h1', providerType: 'huggingface-endpoints', state: 'torn_down' })
    expect(deploymentForCard(shutDown, [hosted])).toBe(hosted)
    expect(deploymentForCard(card({ id: 'other' }), [hosted])).toBeUndefined()
  })
})

describe('cloudAccountLabel', () => {
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
