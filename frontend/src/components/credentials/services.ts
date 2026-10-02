/**
 * Every service a credential can be for, as one list for the Service
 * select of the add-credential form: model providers, memory services, MCP
 * servers, clouds, storage, the general kinds of key (an API key or token,
 * a username and password, an OAuth 2.0 sign-in) and "Custom", for an
 * OpenAI-compatible endpoint, MCP server, memory service or bucket the list
 * does not name.
 *
 * A model provider's key is saved as a provider connection (its models come
 * with it, POST /llm-providers/connect); every other service's through its
 * connector (POST /connectors/:key/connect). Chat apps are not here: they
 * are added on an agent's Channels tab. Model hosting accounts are not
 * either: they are a model provider of the same name.
 */
import { LlmProviderType } from '@/types'
import type { Connector, ConnectorKind } from '@/types/connections'
import { PROVIDER_TILE_ORDER, providerTileLabel } from '@/components/llm-providers/provider-catalog'

/** "Custom": what it is is asked next, then that kind's fields. */
export const CUSTOM_SERVICE = 'custom'

const MODEL_PREFIX = 'model:'

/** The Service select's value for a model provider type. */
export function modelServiceId(type: string): string {
  return `${MODEL_PREFIX}${type}`
}

/** The provider type a Service value names, if it is a model provider. */
export function modelServiceType(id: string | null | undefined): LlmProviderType | null {
  if (!id?.startsWith(MODEL_PREFIX)) return null
  const type = id.slice(MODEL_PREFIX.length)
  return (Object.values(LlmProviderType) as string[]).includes(type) ? (type as LlmProviderType) : null
}

export type ServiceTarget = { kind: 'provider'; providerType: LlmProviderType } | { kind: 'connector'; connectorKey: string }

/** What "Custom" can be, and what each is saved as. */
export const CUSTOM_KINDS: Array<{ id: string; label: string; target: ServiceTarget }> = [
  { id: 'openai-compatible', label: 'OpenAI-compatible endpoint', target: { kind: 'provider', providerType: LlmProviderType.CUSTOM } },
  { id: 'mcp', label: 'MCP server', target: { kind: 'connector', connectorKey: 'mcp-custom' } },
  { id: 'memory', label: 'Memory service', target: { kind: 'connector', connectorKey: 'memory-custom' } },
  { id: 'bucket', label: 'Storage bucket (S3-compatible)', target: { kind: 'connector', connectorKey: 'registry-s3' } },
]

export interface ServiceEntry {
  /** The Service select's value: `model:<type>`, a connector key, or `custom`. */
  id: string
  label: string
  /** A short line after the label. */
  hint?: string
  group: string
  /** What the icon is looked up by: a provider type or a connector key. */
  brand: string | null
  keywords?: string[]
  /** Absent for "Custom", whose target is picked next. */
  target?: ServiceTarget
}

/** The group headings, in the order they are listed. */
export const SERVICE_GROUPS = {
  models: 'Model providers',
  memory: 'Memory',
  mcp: 'MCP servers',
  cloud: 'Clouds',
  storage: 'Storage',
  general: 'General',
  custom: 'Custom',
} as const

const KIND_GROUP: Partial<Record<ConnectorKind, string>> = {
  memory: SERVICE_GROUPS.memory,
  mcp: SERVICE_GROUPS.mcp,
  cloud: SERVICE_GROUPS.cloud,
  registry: SERVICE_GROUPS.storage,
  tool_source: SERVICE_GROUPS.general,
}

/** Connectors listed as something else: the targets of "Custom", and kinds that live elsewhere. */
const LISTED_UNDER_CUSTOM = new Set(['memory-custom'])

/** Names a person reads in the list, where the catalog's own name says less. */
const LABELS: Record<string, { label: string; hint?: string }> = {
  other: { label: 'API key or token', hint: 'any service' },
  'basic-auth': { label: 'Username and password' },
  oauth2: { label: 'OAuth 2.0 sign-in', hint: 'an access token' },
  'toolsource-openapi': { label: 'Key for an imported API', hint: 'with its spec URL' },
  'registry-s3': { label: 'Storage bucket (S3-compatible)' },
}

/** The order of the general kinds of key. */
const GENERAL_ORDER = ['other', 'basic-auth', 'oauth2', 'toolsource-openapi']

export function connectorEntry(connector: Connector): ServiceEntry {
  const named = LABELS[connector.key]
  return {
    id: connector.key,
    label: named?.label ?? connector.displayName,
    hint: named?.hint,
    group: KIND_GROUP[connector.kind] ?? SERVICE_GROUPS.general,
    brand: connector.providerType ?? connector.key,
    keywords: [connector.displayName, connector.description ?? ''].filter(Boolean),
    target: { kind: 'connector', connectorKey: connector.key },
  }
}

export function providerEntry(type: LlmProviderType): ServiceEntry {
  return {
    id: modelServiceId(type),
    label: type === LlmProviderType.CUSTOM ? 'Your own server (OpenAI-compatible)' : providerTileLabel(type),
    group: SERVICE_GROUPS.models,
    brand: type,
    keywords: [type, 'model', 'ai', 'llm'],
    target: { kind: 'provider', providerType: type },
  }
}

export interface ServiceListOptions {
  /** Only model providers (connecting a provider on Models). */
  modelsOnly?: boolean
  /** Only this kind's services (a memory account, a channel's key). */
  kind?: ConnectorKind
  /** Of those, only these connector keys (the memory services almyty has an adapter for). */
  allowedKeys?: string[]
  /** Leave model providers out (a picker that needs a plain credential back). */
  withoutModels?: boolean
}

/** The Service select's entries, in group order. */
export function credentialServices(connectors: Connector[], options: ServiceListOptions = {}): ServiceEntry[] {
  if (options.modelsOnly) return PROVIDER_TILE_ORDER.map(providerEntry)

  if (options.kind) {
    const allowed = options.allowedKeys ? new Set(options.allowedKeys) : null
    return connectors.filter((c) => c.kind === options.kind && (!allowed || allowed.has(c.key))).map(connectorEntry)
  }

  const models = options.withoutModels ? [] : PROVIDER_TILE_ORDER.filter((t) => t !== LlmProviderType.CUSTOM).map(providerEntry)
  const listed = connectors.filter((c) => c.kind !== 'inference' && c.kind !== 'deployment' && c.kind !== 'channel' && !LISTED_UNDER_CUSTOM.has(c.key)).map(connectorEntry)
  const byGroup = (group: string) => listed.filter((e) => e.group === group)
  const general = byGroup(SERVICE_GROUPS.general).sort((a, b) => rank(a.id) - rank(b.id) || a.label.localeCompare(b.label))
  const custom: ServiceEntry = {
    id: CUSTOM_SERVICE,
    label: 'Custom',
    hint: 'OpenAI-compatible endpoint, MCP server, memory service, bucket',
    group: SERVICE_GROUPS.custom,
    brand: null,
    keywords: CUSTOM_KINDS.map((k) => k.label),
  }
  return [
    ...models,
    ...byGroup(SERVICE_GROUPS.memory),
    ...byGroup(SERVICE_GROUPS.mcp),
    ...byGroup(SERVICE_GROUPS.cloud),
    ...byGroup(SERVICE_GROUPS.storage),
    ...general,
    custom,
  ]
}

function rank(id: string): number {
  const i = GENERAL_ORDER.indexOf(id)
  return i === -1 ? GENERAL_ORDER.length : i
}
