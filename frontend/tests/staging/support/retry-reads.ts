import type { APIRequestContext } from '@playwright/test'

/**
 * How often a read is retried when staging resets the connection
 * (ECONNRESET, the only network error Playwright retries). A reset is the
 * network, not the product: J8 once failed on "socket hang up" after its
 * 75 s wait, and passed when run again.
 */
export const READ_RETRIES = 2

const READS = ['get', 'head', 'delete'] as const

/**
 * The context with reads retried on a reset connection. Only idempotent
 * methods: a POST, PUT or PATCH that reached the server before the reset
 * would run twice if it were sent again. A caller's own maxRetries wins.
 */
export function withRetriedReads<T extends Pick<APIRequestContext, (typeof READS)[number]>>(ctx: T): T {
  for (const method of READS) {
    const send = ctx[method].bind(ctx) as (url: string, options?: Record<string, unknown>) => Promise<unknown>
    ;(ctx as any)[method] = (url: string, options: Record<string, unknown> = {}) =>
      send(url, { maxRetries: READ_RETRIES, ...options })
  }
  return ctx
}
