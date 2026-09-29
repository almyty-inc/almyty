import type { ModelCard } from '@/types/models'
import type { ModelAdapter, ModelDeployment } from '@/types/deployments'

/**
 * Open models almyty runs on your own cloud account, in the words a person
 * uses. The backend calls one a deployment (`/model-deployments`); nothing
 * a user reads does.
 */
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

export function cloudAccountLabel(adapterKey: string | null | undefined, adapters: Pick<ModelAdapter, 'key' | 'displayName'>[] = []): string {
  if (!adapterKey) return 'Your cloud account'
  if (CLOUD_ACCOUNT_LABELS[adapterKey]) return CLOUD_ACCOUNT_LABELS[adapterKey]
  const name = adapters.find((a) => a.key === adapterKey)?.displayName ?? adapterKey
  return `Your ${name} account`
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
