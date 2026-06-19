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
