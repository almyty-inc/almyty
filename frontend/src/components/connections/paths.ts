/** Where the Connections pages live. One place, so a move is one edit. */
export const CONNECTIONS_PATH = '/connections'
export const CONNECTIONS_ADVANCED_PATH = '/connections/advanced'
export const CONNECTIONS_QUERY_KEY = ['connections'] as const

/** The connect page, optionally opened on one service. */
export function connectServicePath(serviceKey?: string | null, returnTo?: string | null): string {
  const params = new URLSearchParams()
  if (serviceKey) params.set('service', serviceKey)
  if (returnTo) params.set('returnTo', returnTo)
  const query = params.toString()
  return `${CONNECTIONS_PATH}/connect${query ? `?${query}` : ''}`
}

export function connectionPath(id: string): string {
  return `${CONNECTIONS_PATH}/${encodeURIComponent(id)}`
}

/** Advanced, opened on who can use one connection. */
export function connectionAccessPath(id: string): string {
  return `${CONNECTIONS_ADVANCED_PATH}?connection=${encodeURIComponent(id)}`
}
