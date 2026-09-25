import { StatusLabel, type ServiceCheck } from '@/components/connect/status-label'
import { currentProviderFailure, type ProviderHealthFields } from '@/lib/provider-health'

export type ProviderCheck = ServiceCheck

const KEY_WORDS = /\b40[13]\b|unauthori[sz]ed|forbidden|authentication|invalid[_ ]?(api[_ ]?)?key|incorrect api key|api key not valid|rejected this key/i

/**
 * The provider's key, in two words. A failing last check is "Key rejected"
 * when the provider said the key is wrong and "Check failed" otherwise
 * (a network problem, the provider down). Otherwise the key works once any
 * check passed, which a usable model also proves.
 */
export function providerCheck(p: (ProviderHealthFields & { lastHealthCheckAt?: string | null }) | null | undefined, hasUsableModel = false): ProviderCheck {
  if (!p) return { state: 'unchecked', label: 'Not checked yet' }
  const failure = currentProviderFailure(p)
  const error = failure?.message ?? (p.status === 'error' ? p.lastError || undefined : undefined)
  if (failure || p.status === 'error') {
    return KEY_WORDS.test(error || '') ? { state: 'rejected', label: 'Key rejected', error } : { state: 'failed', label: 'Check failed', error }
  }
  if (p.lastSuccessAt || p.lastHealthCheckAt || hasUsableModel) return { state: 'ok', label: 'Key works' }
  return { state: 'unchecked', label: 'Not checked yet' }
}

export function ProviderStatus({ check, className }: { check: ProviderCheck; className?: string }) {
  return <StatusLabel check={check} className={className} testId="provider-status" />
}
