import { describe, it, expect } from 'vitest'
import { shouldRetryRequest, computeRetryDelay } from '../api'

/**
 * Regression tests for the api.ts retry interceptor. Two concerns:
 *
 * 1. The previous shape retried non-idempotent methods (POST / PATCH /
 *    DELETE) on transient 5xx responses. If the server had already
 *    started the state-changing work and then crashed, a blind retry
 *    would turn a single user action into a double-create /
 *    double-charge / double-delete. Retries are now confined to
 *    idempotent methods via `shouldRetryRequest`.
 *
 * 2. The previous shape ignored Retry-After on 429 / 503. A backend
 *    that rate-limited the client was hit again 1 second later,
 *    triggering the same limit. `computeRetryDelay` now honours it.
 *
 * These are pure-function tests because the frontend test setup
 * mocks axios globally; the real retry logic lives inside the axios
 * response interceptor, so we extracted the decision into standalone
 * helpers that the interceptor delegates to.
 */

describe('shouldRetryRequest — method idempotency gate', () => {
  const transient = { errorCode: undefined, statusCode: 500, message: undefined }

  it.each([
    ['GET',     'get',     true],
    ['HEAD',    'head',    true],
    ['OPTIONS', 'options', true],
    ['PUT',     'put',     true],
    ['DELETE',  'delete',  true],
    // POST and PATCH are non-idempotent — must NEVER retry.
    ['POST',    'post',    false],
    ['PATCH',   'patch',   false],
  ])('retries %s on 500: %s', (_name, method, expected) => {
    expect(shouldRetryRequest({ method, ...transient })).toBe(expected)
  })

  it('defaults to GET (retryable) when method is undefined', () => {
    expect(shouldRetryRequest({ method: undefined, ...transient })).toBe(true)
  })

  it('does not retry a 400 Bad Request even on a GET', () => {
    expect(
      shouldRetryRequest({
        method: 'get',
        errorCode: undefined,
        statusCode: 400,
        message: undefined,
      }),
    ).toBe(false)
  })

  it.each([
    408, 429, 500, 502, 503, 504,
  ])('retries GET on transient status %i', (statusCode) => {
    expect(
      shouldRetryRequest({
        method: 'get',
        errorCode: undefined,
        statusCode,
        message: undefined,
      }),
    ).toBe(true)
  })

  it.each([
    'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENETUNREACH',
  ])('retries GET on transient node error code %s', (errorCode) => {
    expect(
      shouldRetryRequest({
        method: 'get',
        errorCode,
        statusCode: undefined,
        message: undefined,
      }),
    ).toBe(true)
  })

  it('retries GET on "socket hang up" error message', () => {
    expect(
      shouldRetryRequest({
        method: 'get',
        errorCode: undefined,
        statusCode: undefined,
        message: 'socket hang up',
      }),
    ).toBe(true)
  })

  it('does NOT retry POST on "socket hang up" (non-idempotent wins)', () => {
    // Even for transient-looking network errors, POST is still not
    // safe to replay — the server may have received and executed
    // the request before the socket was torn down.
    expect(
      shouldRetryRequest({
        method: 'post',
        errorCode: 'ECONNRESET',
        statusCode: undefined,
        message: 'socket hang up',
      }),
    ).toBe(false)
  })
})

describe('computeRetryDelay — Retry-After handling', () => {
  it('falls back to exponential backoff when no header is present', () => {
    expect(computeRetryDelay(undefined, 0)).toBe(1000)
    expect(computeRetryDelay(undefined, 1)).toBe(2000)
    expect(computeRetryDelay(undefined, 2)).toBe(4000)
  })

  it('honours a numeric Retry-After (seconds)', () => {
    expect(computeRetryDelay('5', 0)).toBe(5000)
    expect(computeRetryDelay('12', 1)).toBe(12000)
  })

  it('honours an HTTP-date Retry-After', () => {
    const now = 1_700_000_000_000
    const future = new Date(now + 7_000).toUTCString()
    const delay = computeRetryDelay(future, 0, now)
    expect(delay).toBeGreaterThanOrEqual(6_000)
    expect(delay).toBeLessThanOrEqual(8_000)
  })

  it('caps Retry-After at the hard limit (30s)', () => {
    expect(computeRetryDelay('600', 0)).toBe(30_000)
  })

  it('caps HTTP-date Retry-After at the hard limit too', () => {
    const now = 1_700_000_000_000
    const farFuture = new Date(now + 3_600_000).toUTCString()
    expect(computeRetryDelay(farFuture, 0, now)).toBe(30_000)
  })

  it('returns 0 for an HTTP-date Retry-After already in the past', () => {
    const now = 1_700_000_000_000
    const past = new Date(now - 10_000).toUTCString()
    expect(computeRetryDelay(past, 0, now)).toBe(0)
  })

  it('falls through to exponential backoff for garbage Retry-After', () => {
    expect(computeRetryDelay('not-a-number-or-date', 2)).toBe(4000)
  })
})
