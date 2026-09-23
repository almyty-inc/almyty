import { llmProvidersApi } from '@/lib/api'

/**
 * The one definition of the organization's inference-provider list query.
 *
 * Eleven components each wrote their own `useQuery({ queryKey:
 * ['llm-providers'], queryFn })`. Some returned the raw response (sometimes a
 * `{ providers }` envelope), others a normalized array -- under ONE cache key.
 * React Query keeps whichever fetched first, so a component expecting an
 * array was handed the envelope. /models then threw `(data || []).map is
 * not a function` and rendered a blank page, but only when you arrived from
 * a page that had fetched the envelope; a hard refresh fetched the array
 * first and it worked.
 *
 * Always an array. Errors are not swallowed (see llm-providers.tsx: an empty
 * list on a 500 hid providers that still existed).
 */
export const LLM_PROVIDERS_KEY = ['llm-providers'] as const

export async function fetchLlmProviders(): Promise<any[]> {
  const response: any = await llmProvidersApi.getAll()
  const list = Array.isArray(response) ? response : response?.providers
  return Array.isArray(list) ? list : []
}

export const llmProvidersQuery = {
  queryKey: LLM_PROVIDERS_KEY,
  queryFn: fetchLlmProviders,
}
