/**
 * The POST /model-deployments body behind "Start a model" on a provider's
 * page, and the words for a spending cap. Pure functions, so the rules are
 * tested without rendering a form.
 */
import { schemaWithoutSecretRequirements, secretPropertyKeys, stripSecretValues, validateSchemaValues, type SchemaFormValues } from '@/components/ui/json-schema-form'
import { formatCents, matchAdapters, parseModelRef } from '@/lib/deployments-api'
import type { CreateModelDeploymentBody, ModelAdapter, PrivacyTier, SpendBudgetSummary } from '@/types/deployments'

export interface DesiredFormValues {
  hardware: string
  replicas: string
  minScale: string
  maxScale: string
  quantization: string
  region: string
  privacyTier: '' | PrivacyTier
}

export const EMPTY_DESIRED: DesiredFormValues = { hardware: '', replicas: '1', minScale: '', maxScale: '', quantization: '', region: '', privacyTier: 'private_cloud' }

export interface HostFormState {
  adapter: ModelAdapter | null
  /** Where the model is. This is the whole model configuration. */
  model: string
  /** What to call it in the Models list. Defaults to the repository name. */
  name?: string
  /** Architecture family, when the cloud checks it and the source carries none. */
  base?: string
  desired: DesiredFormValues
  config: SchemaFormValues
  credentialId: string
  budgetId: string
  /** A connected account from the Connections layer, instead of a vault credential. */
  connectionId?: string
}

export type HostBuildResult = { ok: true; body: CreateModelDeploymentBody } | { ok: false; errors: Record<string, string> }

/**
 * Turn the form into the POST /model-deployments body, or the field errors
 * that stop it.
 *
 * The model source is configuration: nothing has to be registered first.
 * A Hugging Face repository may be named without a commit; the server pins
 * it to the exact revision before anything starts. Compatibility is checked
 * here too, with the integration's own `modelSchemes`, so the common
 * refusal never costs a round trip.
 */
export function buildHostBody(state: HostFormState): HostBuildResult {
  const errors: Record<string, string> = {}
  if (!state.adapter) errors.adapter = 'Pick the cloud that runs it'

  const model = (state.model ?? '').trim()
  const parsed = model ? parseModelRef(model) : null
  if (!model) {
    errors.model = 'Say which model to run'
  } else if (parsed && !parsed.ok) {
    errors.model = parsed.error
  } else if (parsed && parsed.ok && state.adapter) {
    const match = matchAdapters([state.adapter], parsed.value.scheme)[0]
    if (match && !match.ok && match.reason) errors.model = match.reason
  }

  const desired: CreateModelDeploymentBody['desired'] = {}
  const int = (key: keyof DesiredFormValues, label: string, min: number) => {
    const raw = state.desired[key].trim()
    if (raw === '') return undefined
    const n = Number(raw)
    if (!Number.isInteger(n) || n < min) {
      errors[key] = `${label} must be a whole number of at least ${min}`
      return undefined
    }
    return n
  }
  const replicas = int('replicas', 'Copies', 0)
  const minScale = int('minScale', 'Min copies', 0)
  const maxScale = int('maxScale', 'Max copies', 0)
  if (replicas !== undefined) desired.replicas = replicas
  if (minScale !== undefined) desired.minScale = minScale
  if (maxScale !== undefined) desired.maxScale = maxScale
  if (minScale !== undefined && maxScale !== undefined && minScale > maxScale) errors.maxScale = 'Max copies must be at least min copies'
  if (state.desired.hardware.trim()) desired.hardware = state.desired.hardware.trim()
  if (state.desired.region.trim()) desired.region = state.desired.region.trim()
  if (state.desired.quantization.trim()) desired.quantization = state.desired.quantization.trim()
  if (state.desired.privacyTier) desired.privacyTier = state.desired.privacyTier

  // A connection (a picked credential or one made in the connect sheet)
  // supplies the integration's secrets: they are neither required nor sent,
  // so the backend never sees PROVIDER_CONFIG_INLINE_SECRET from this form.
  const connectionId = state.credentialId || state.connectionId || ''
  const schema = connectionId ? schemaWithoutSecretRequirements(state.adapter?.configSchema) : state.adapter?.configSchema
  const config = validateSchemaValues(schema, state.config, { mode: 'create' })
  for (const [k, v] of Object.entries(config.errors)) errors[`config.${k}`] = v

  if (Object.keys(errors).length > 0) return { ok: false, errors }

  const body: CreateModelDeploymentBody = { providerType: state.adapter!.key, model: parsed && parsed.ok ? parsed.value.raw : model }
  if (state.name?.trim()) body.name = state.name.trim()
  if (state.base?.trim()) body.base = state.base.trim()
  if (Object.keys(desired).length > 0) body.desired = desired
  const providerConfig = connectionId ? stripSecretValues(state.adapter?.configSchema, config.value) : config.value
  if (Object.keys(providerConfig).length > 0) body.providerConfig = providerConfig
  if (connectionId) body.credentialId = connectionId
  if (state.budgetId) body.budgetId = state.budgetId
  return { ok: true, body }
}

/** True when the integration's form has x-secret fields the user would otherwise paste. */
export function adapterHasSecrets(adapter: ModelAdapter | null): boolean {
  return !!adapter && secretPropertyKeys(adapter.configSchema).length > 0
}

export function describeBudget(b: SpendBudgetSummary): string {
  const scope = b.agentId ? 'one agent' : b.llmProviderId ? 'one provider' : 'whole org'
  return `${formatCents(b.limitCents)} per ${b.periodType} (${scope}, ${b.behavior === 'reject' ? 'hard stop' : 'warn'})`
}
