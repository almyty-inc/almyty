import type { AxiosError } from 'axios'

// Backend errors are wrapped as { error: { code, message, statusCode, ... } }.
// Older callsites read response.data.message — that path is undefined for the
// wrapped shape, so the toast falls back to a generic message OR the surrounding
// React commit throws and the mutation hangs (see findings T3/T4).
export function getApiErrorMessage(err: unknown, fallback = 'Request failed'): string {
  const e = err as AxiosError<any> | undefined
  return (
    e?.response?.data?.error?.message
    ?? e?.response?.data?.message
    ?? (e instanceof Error ? e.message : undefined)
    ?? fallback
  )
}

/**
 * The thing asked for does not exist (or is not this org's): a 404, or the
 * 400 the API answers for an id that is not an id at all. Retrying cannot
 * help either one, so a page shows "not found" with a way back instead.
 */
export function isNotFoundError(err: unknown): boolean {
  const e = err as AxiosError<any> | undefined
  const status = e?.response?.status ?? e?.response?.data?.error?.statusCode
  if (status === 404) return true
  if (e?.response?.data?.error?.code === 'NOT_FOUND') return true
  return status === 400 && /uuid is expected/i.test(getApiErrorMessage(err, ''))
}