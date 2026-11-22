/**
 * Where provider connections live: under Models, whose models they bring.
 * Their keys are credentials too, and Credentials lists them, but a
 * connection is opened, connected and changed here. One place, so every
 * link to them is built the same way.
 */
export const PROVIDER_CONNECTIONS_PATH = '/models/providers'

/** Connecting a provider, optionally opened on one provider and coming back to `returnTo` when done. */
export function connectProviderPath(type?: string | null, returnTo?: string | null): string {
  const params = new URLSearchParams()
  if (type) params.set('type', type)
  if (returnTo) params.set('returnTo', returnTo)
  const query = params.toString()
  return `${PROVIDER_CONNECTIONS_PATH}/new${query ? `?${query}` : ''}`
}

/**
 * One provider connection's page, optionally at one of its models.
 * `returnTo` is the page that opened it (Credentials passes its own path),
 * so the page's back link and "remove" lead back there.
 */
export function providerPath(id: string, modelId?: string | null, returnTo?: string | null): string {
  const query = returnTo ? `?${new URLSearchParams({ returnTo }).toString()}` : ''
  return `${PROVIDER_CONNECTIONS_PATH}/${encodeURIComponent(id)}${query}${modelId ? `#model-${modelId}` : ''}`
}

/**
 * Where a provider connection's page goes back to: Credentials when it was
 * opened from there, Models otherwise (opened from Models, or directly).
 * `returnTo` must already be checked with safeReturnTo.
 */
export function providerBack(returnTo: string | null | undefined): { to: string; label: string } {
  if (returnTo && /^\/credentials(?:[/?#]|$)/.test(returnTo)) return { to: returnTo, label: 'Credentials' }
  if (returnTo && /^\/models(?:[/?#]|$)/.test(returnTo)) return { to: returnTo, label: 'Models' }
  return { to: '/models', label: 'Models' }
}