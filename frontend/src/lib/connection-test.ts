/**
 * The sentence an API's "Test connection" shows. The server writes it
 * (apis/connection-test-result.ts); the page never prints the raw answer,
 * which used to read `{"success":false,"statusCode":400}`.
 */
export function connectionTestMessage(result: unknown): string {
  const r = (result ?? {}) as { success?: boolean; message?: unknown; error?: unknown }
  if (typeof r.message === 'string' && r.message.trim()) return r.message
  if (typeof r.error === 'string' && r.error.trim()) return r.error
  return r.success === false ? 'The API did not answer.' : 'The API answered.'
}
