import { StatusLabel, type ServiceCheck } from '@/components/connect/status-label'
import { currentProviderFailure, type ProviderHealthFields } from '@/lib/provider-health'

export type ProviderCheck = ServiceCheck

const KEY_WORDS = /\b40[13]\b|unauthori[sz]ed|forbidden|authentication|invalid[_ ]?(api[_ ]?)?key|incorrect api key|api key not valid|rejected this key/i

/**
 * The provider's key, in two words, by the same rule that makes its models
 * usable: the backend sends `keyChecked` (the key check ran and passed, and
 * the provider is on), and every model the provider lists is usable while
 * it holds. So "Key works" never sits over a list of models that are not.
 *
 * Otherwise a failed check, or a later call the vendor refused, is "Key
 * rejected" when the provider said the key is wrong and "Check failed"
 * otherwise (a network problem, the provider down); with neither it is
 * "Not checked yet".
 */
export function providerCheck(p: (ProviderHealthFields & { lastHealthCheckAt?: string | null; keyChecked?: boolean }) | null | undefined): ProviderCheck {
  if (!p) return { state: 'unchecked', label: 'Not checked yet' }
  if (p.keyChecked === true) return { state: 'ok', label: 'Key works' }
  const failure = currentProviderFailure(p)
  const checkFailed = !!p.lastHealthCheckAt && p.isHealthy === false
  if (failure || checkFailed || p.status === 'error') {
    const error = failure?.message ?? (p.lastError || undefined)
    return KEY_WORDS.test(error || '') ? { state: 'rejected', label: 'Key rejected', error } : { state: 'failed', label: 'Check failed', error }
  }
  return { state: 'unchecked', label: 'Not checked yet' }
}

export function ProviderStatus({ check, className }: { check: ProviderCheck; className?: string }) {
  return <StatusLabel check={check} className={className} testId="provider-status" />
}
