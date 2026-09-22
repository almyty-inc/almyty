import type { ModelAdapter, ModelDeployment, ModelVersion } from '@/types/deployments'

/** Reads a Hub repo or a local path, like the real Ollama adapter. */
export const ollamaAdapter: ModelAdapter = {
  key: 'ollama',
  displayName: 'Ollama',
  capabilities: { architectures: 'any', lora: 'merged', serverless: false, dedicated: true, scaleToZero: true, regions: [], registrySources: ['hub', 'local'] },
  modelSchemes: ['hf://', 'file://'],
  configSchema: {
    type: 'object',
    properties: {
      baseUrl: { type: 'string', title: 'Ollama server URL', default: 'http://localhost:11434' },
      token: { type: 'string', title: 'Bearer token', 'x-secret': true },
      hourlyRateCents: { type: 'integer', title: 'Machine price per hour (cents)' },
    },
    required: ['baseUrl'],
  },
}

/** Serves a Hub repository and nothing else. */
export const hfAdapter: ModelAdapter = {
  key: 'huggingface-endpoints',
  displayName: 'Hugging Face Endpoints',
  capabilities: { architectures: ['llama', 'qwen'], lora: 'none', serverless: true, dedicated: true, scaleToZero: true, regions: ['us-east-1', 'eu-west-1'], registrySources: ['hub'] },
  modelSchemes: ['hf://'],
  configSchema: {
    type: 'object',
    properties: {
      apiToken: { type: 'string', title: 'API token', 'x-secret': true },
      namespace: { type: 'string', title: 'Namespace' },
    },
    required: ['apiToken'],
  },
}

/** Imports from S3, and owns the bedrock:// reference. */
export const bedrockAdapter: ModelAdapter = {
  key: 'aws-bedrock-import',
  displayName: 'Amazon Bedrock',
  capabilities: { architectures: ['llama', 'qwen'], lora: 'merged', serverless: true, dedicated: false, scaleToZero: true, regions: ['us-east-1'], registrySources: ['s3'] },
  modelSchemes: ['s3://', 'bedrock://'],
  configSchema: { type: 'object', properties: { roleArn: { type: 'string', title: 'Role ARN' } }, required: ['roleArn'] },
}

/** Owns the fireworks:// reference and reads S3 with the customer's own role. */
export const fireworksAdapter: ModelAdapter = {
  key: 'fireworks',
  displayName: 'Fireworks',
  capabilities: { architectures: 'any', lora: 'multi', serverless: true, dedicated: true, scaleToZero: true, regions: [], registrySources: ['s3'] },
  modelSchemes: ['s3://', 'fireworks://'],
  configSchema: { type: 'object', properties: { accountId: { type: 'string', title: 'Account id' } }, required: ['accountId'] },
}

export function makeVersion(overrides: Partial<ModelVersion> = {}): ModelVersion {
  return {
    id: 'v-1',
    name: 'support-bot-v3',
    registryUri: 'hf://acme/support-bot-v3@e3b0c442',
    base: 'qwen3-14b',
    sizeBytes: '29000000000',
    quantizations: ['bf16', 'awq-int4'],
    lineage: null,
    manifestSha: 'abc123',
    metadata: null,
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    ...overrides,
  }
}

export function makeDeployment(overrides: Partial<ModelDeployment> = {}): ModelDeployment {
  return {
    id: 'd-1',
    modelVersionId: null,
    modelRef: 'hf://acme/support-bot-v3@e3b0c442',
    modelBase: null,
    modelId: null,
    providerType: 'ollama',
    desired: { replicas: 1 },
    providerConfig: { baseUrl: 'http://gpu:11434', token: '********' },
    externalRef: null,
    actual: null,
    state: 'pending',
    lastReconcileAt: null,
    lastError: null,
    budgetId: null,
    createdAt: new Date(Date.now() - 600_000).toISOString(),
    ...overrides,
  }
}
