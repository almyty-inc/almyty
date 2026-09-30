/** Where the Credentials pages live. One place, so a move is one edit. */
export const CREDENTIALS_PATH = '/credentials'
export const CREDENTIALS_ADVANCED_PATH = '/credentials/advanced'
/** The cache key of GET /connections, the list every credential surface reads. */
export const CONNECTIONS_QUERY_KEY = ['connections'] as const
/** The cache key of GET /credentials, which also lists the keys a single API or tool keeps. */
export const CREDENTIALS_QUERY_KEY = ['credentials'] as const

/** "Add credential", optionally opened on one service. */
export function addCredentialPath(serviceKey?: string | null, returnTo?: string | null): string {
  const params = new URLSearchParams()
  if (serviceKey) params.set('service', serviceKey)
  if (returnTo) params.set('returnTo', returnTo)
  const query = params.toString()
  return `${CREDENTIALS_PATH}/new${query ? `?${query}` : ''}`
}

export function credentialPath(id: string): string {
  return `${CREDENTIALS_PATH}/${encodeURIComponent(id)}`
}

/** Advanced, opened on who can use one credential. */
export function credentialAccessPath(id: string): string {
  return `${CREDENTIALS_ADVANCED_PATH}?credential=${encodeURIComponent(id)}`
}
