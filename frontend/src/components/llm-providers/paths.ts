/**
 * Where provider connections live: under Credentials, next to every other
 * key. The Models page is the catalog of what they reach and links here.
 * One place, so every link to them is built the same way.
 */
export const PROVIDER_CONNECTIONS_PATH = '/credentials/providers'

/** Connecting a provider, optionally opened on one tile and coming back to `returnTo` when done. */
export function connectProviderPath(type?: string | null, returnTo?: string | null): string {
  const params = new URLSearchParams()
  if (type) params.set('type', type)
  if (returnTo) params.set('returnTo', returnTo)
  const query = params.toString()
  return `${PROVIDER_CONNECTIONS_PATH}/new${query ? `?${query}` : ''}`
}

/** One provider connection's page, optionally at one of its models. */
export function providerPath(id: string, modelId?: string | null): string {
  return `${PROVIDER_CONNECTIONS_PATH}/${encodeURIComponent(id)}${modelId ? `#model-${modelId}` : ''}`
}
