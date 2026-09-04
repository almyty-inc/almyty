/**
 * Is a provider failing right now?
 *
 * `isHealthy` is the health-check gate and stays true through transient
 * vendor errors on purpose (flipping it would block every call). What
 * an operator needs to see is whether the LAST thing that happened was
 * a failure: lastError is current when it is newer than the last
 * success. Anything older is history, not a warning.
 */
export interface ProviderHealthFields {
  lastError?: string | null
  lastErrorAt?: string | null
  lastSuccessAt?: string | null
  isHealthy?: boolean
  status?: string
}

export function currentProviderFailure(p: ProviderHealthFields): { message: string; at: string } | null {
  if (!p.lastError || !p.lastErrorAt) return null
  if (p.lastSuccessAt && new Date(p.lastSuccessAt).getTime() >= new Date(p.lastErrorAt).getTime()) return null
  return { message: p.lastError, at: p.lastErrorAt }
}
