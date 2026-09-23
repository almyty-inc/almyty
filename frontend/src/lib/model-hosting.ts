import type { ModelCard } from '@/types/models'
import type { ModelAdapter, ModelDeployment } from '@/types/deployments'
import { providerTypeLabels } from '@/components/llm-providers/provider-type-config'

/**
 * Where a model runs, in the words a person uses.
 *
 * A model is one thing whichever way it is reached. Where it runs is an
 * attribute of it: a vendor's API through an inference provider, a server
 * the organization runs itself, or the organization's own cloud account,
 * where almyty starts and stops it. The backend calls the last one a
 * deployment (`/model-deployments`); nothing a user reads does.
 */
export type ModelSource = 'provider' | 'server' | 'cloud'

export const MODEL_SOURCE_LABELS: Record<ModelSource, string> = {
  provider: 'Provider API',
  server: 'Your server',
  cloud: 'Your cloud',
}

/** Provider types that are a server the organization runs, not a vendor's API. */
const SERVER_PROVIDER_TYPES = new Set(['custom', 'ollama'])

export function modelSource(card: Pick<ModelCard, 'endpointRef' | 'providerType'>, hosted?: Pick<ModelDeployment, 'providerType'> | null): ModelSource {
  // A hosted model stays one after it is shut down: the reconcile loop
  // clears its endpointRef then, but the hosting record still names it.
  if (hosted || card.endpointRef?.deploymentId) return 'cloud'
  if (card.providerType && SERVER_PROVIDER_TYPES.has(card.providerType)) return 'server'
  // A card that carries only a URL was pointed at a server by hand.
  if (card.endpointRef?.url) return 'server'
  return 'provider'
}

/** Whose cloud account each hosting integration runs in, keyed by adapter key. */
const CLOUD_ACCOUNT_LABELS: Record<string, string> = {
  'huggingface-endpoints': 'Your Hugging Face account (Inference Endpoint)',
  modal: 'Your Modal account',
  'aws-bedrock-import': 'Your AWS account (Bedrock)',
  sagemaker: 'Your AWS account (SageMaker)',
  vertex: 'Your Google Cloud account (Vertex AI)',
  'azure-foundry': 'Your Azure account (Microsoft Foundry)',
  baseten: 'Your Baseten account',
  together: 'Your Together AI account',
  fireworks: 'Your Fireworks AI account',
  nebius: 'Your Nebius account',
  runpod: 'Your RunPod account',
  digitalocean: 'Your DigitalOcean account',
  ollama: 'Your Ollama server',
  'custom-endpoint': 'Your server',
  stub: 'Test cloud (in memory)',
}

/** The short name of a cloud in the "host it on your cloud" picker. */
const CLOUD_NAMES: Record<string, string> = {
  'huggingface-endpoints': 'Hugging Face Inference Endpoints',
  modal: 'Modal',
  'aws-bedrock-import': 'AWS Bedrock',
  sagemaker: 'Amazon SageMaker',
  vertex: 'Google Vertex AI',
  'azure-foundry': 'Microsoft Foundry',
  baseten: 'Baseten',
  together: 'Together AI (dedicated)',
  fireworks: 'Fireworks AI (on demand)',
  nebius: 'Nebius Token Factory',
  runpod: 'RunPod Serverless',
  digitalocean: 'DigitalOcean Gradient AI',
  ollama: 'Ollama server',
  stub: 'Test cloud (in memory)',
}

/**
 * Hosting integrations that are not "your cloud". `custom-endpoint` only
 * watches a server someone else runs; in the UI that is "A server you run",
 * a custom inference provider, so it is never offered as a cloud.
 */
export const NOT_A_CLOUD: ReadonlySet<string> = new Set(['custom-endpoint'])

export function cloudAccountLabel(adapterKey: string | null | undefined, adapters: Pick<ModelAdapter, 'key' | 'displayName'>[] = []): string {
  if (!adapterKey) return 'Your cloud account'
  if (CLOUD_ACCOUNT_LABELS[adapterKey]) return CLOUD_ACCOUNT_LABELS[adapterKey]
  const name = adapters.find((a) => a.key === adapterKey)?.displayName ?? adapterKey
  return `Your ${name} account`
}

export function cloudName(adapter: Pick<ModelAdapter, 'key' | 'displayName'>): string {
  return CLOUD_NAMES[adapter.key] ?? adapter.displayName
}

export interface ProviderInfo {
  id: string
  name: string
  type: string
  apiUrl?: string | null
}

function hostOf(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

/** "Anthropic API", "Your server (llm.internal)", "Your AWS account (Bedrock)". */
export function runsOn(
  card: Pick<ModelCard, 'endpointRef' | 'providerId' | 'providerType'>,
  providers: Record<string, ProviderInfo> = {},
  adapters: Pick<ModelAdapter, 'key' | 'displayName'>[] = [],
  hosted?: Pick<ModelDeployment, 'providerType'> | null,
): string {
  const source = modelSource(card, hosted)
  const provider = card.providerId ? providers[card.providerId] : undefined
  if (source === 'cloud') return cloudAccountLabel(hosted?.providerType ?? (card.endpointRef?.providerType as string | undefined), adapters)
  if (source === 'server') {
    const host = hostOf(provider?.apiUrl) ?? hostOf(card.endpointRef?.url as string | undefined)
    if (card.providerType === 'ollama' || provider?.type === 'ollama') return host ? `Your Ollama server (${host})` : 'Your Ollama server'
    return host ? `Your server (${host})` : provider?.name ? `Your server (${provider.name})` : 'Your server'
  }
  const type = provider?.type ?? card.providerType
  if (type) {
    const label = (providerTypeLabels as Record<string, string>)[type] ?? type
    return `${label} API`
  }
  return 'Not connected'
}

/** The state of a model hosted on your cloud, as a person reads it. */
export type HostedStatusTone = 'starting' | 'running' | 'idle' | 'stopped' | 'attention' | 'failed'

export interface HostedStatus {
  label: string
  tone: HostedStatusTone
  /** The cloud is still working on it; the UI polls and pulses. */
  moving: boolean
  /** One sentence on what this means. */
  hint: string
}

export function hostedStatus(d: Pick<ModelDeployment, 'state' | 'desired' | 'actual'>): HostedStatus {
  const wantsZero = d.desired?.replicas === 0
  switch (d.state) {
    case 'pending':
    case 'deploying':
      return { label: 'Starting', tone: 'starting', moving: true, hint: 'Your cloud is bringing the model up. This can take several minutes.' }
    case 'ready':
      if (wantsZero || d.actual?.state === 'stopped') {
        return { label: 'Stopped', tone: 'stopped', moving: false, hint: 'Nothing is running and nothing is billed. Start it again any time.' }
      }
      if (d.actual?.replicas === 0) {
        return { label: 'Scaled to zero', tone: 'idle', moving: false, hint: 'Idle and not billed. The next request wakes it up.' }
      }
      return { label: 'Running', tone: 'running', moving: false, hint: 'Serving requests.' }
    case 'scaling':
      return { label: 'Resizing', tone: 'starting', moving: true, hint: 'Your cloud is changing how many copies run.' }
    case 'degraded':
      return { label: 'Needs attention', tone: 'attention', moving: false, hint: 'Your cloud reports a problem. See the last error.' }
    case 'tearing_down':
      return { label: 'Shutting down', tone: 'starting', moving: true, hint: 'The model is being removed from your cloud.' }
    case 'torn_down':
      return { label: 'Shut down', tone: 'stopped', moving: false, hint: 'Removed from your cloud. Nothing is billed.' }
    case 'orphaned':
      return { label: 'Missing from your cloud', tone: 'failed', moving: false, hint: 'Your cloud no longer has it. Shut it down here, or host it again.' }
    case 'failed':
    default:
      return { label: 'Failed', tone: 'failed', moving: false, hint: 'It could not be started. See the last error.' }
  }
}

/** Cents per hour, or null when the cloud has not reported a rate. */
export function hourlyCents(d: Pick<ModelDeployment, 'actual'> | null | undefined): number | null {
  const rate = d?.actual?.ratePerHourCents
  return typeof rate === 'number' && Number.isFinite(rate) ? rate : null
}

/** The hosting record behind a card, found either way round. */
export function deploymentForCard(card: Pick<ModelCard, 'id' | 'endpointRef'>, deployments: ModelDeployment[]): ModelDeployment | undefined {
  const byRef = card.endpointRef?.deploymentId
  if (byRef) {
    const hit = deployments.find((d) => d.id === byRef)
    if (hit) return hit
  }
  return deployments.find((d) => d.modelId === card.id)
}

/**
 * Hosted models with no card to show them on. The backend creates the card
 * with the hosting request; this catches anything made without one, so a
 * model that is billing on someone's cloud never disappears from the list.
 */
export function unlistedDeployments(cards: Pick<ModelCard, 'id' | 'endpointRef'>[], deployments: ModelDeployment[]): ModelDeployment[] {
  const cardIds = new Set(cards.map((c) => c.id))
  const claimed = new Set(cards.map((c) => c.endpointRef?.deploymentId).filter(Boolean))
  return deployments.filter((d) => !claimed.has(d.id) && !(d.modelId && cardIds.has(d.modelId)) && d.state !== 'torn_down')
}

/** "Llama-3.1-8B-Instruct" out of hf://meta-llama/Llama-3.1-8B-Instruct@abc. */
export function readableModelName(reference: string | null | undefined): string {
  const raw = (reference ?? '').trim()
  if (!raw) return 'Hosted model'
  const body = raw.includes('://') ? raw.slice(raw.indexOf('://') + 3) : raw
  const noPin = body.replace(/@[^/]*$/, '')
  const parts = noPin.split('/').filter(Boolean)
  return parts[parts.length - 1] || noPin || 'Hosted model'
}

/** Plain facts about what a hosted model is made from: "Based on qwen3-14b, int4". */
export function lineageFacts(input: { base?: string | null; quantization?: string | null }): string | null {
  const facts: string[] = []
  if (input.base) facts.push(`Based on ${input.base}`)
  if (input.quantization) facts.push(input.quantization)
  return facts.length ? facts.join(', ') : null
}
