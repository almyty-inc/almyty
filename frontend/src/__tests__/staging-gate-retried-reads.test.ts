import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

import { READ_RETRIES, withRetriedReads } from '../../tests/staging/support/retry-reads'

// The staging gate's API context retries reads when staging resets the
// connection, so a network blip does not fail a journey; writes are never
// sent twice.

function fakeContext() {
  const calls: Array<{ method: string; options: any }> = []
  const record = (method: string) => async (_url: string, options?: any) => {
    calls.push({ method, options })
    return {}
  }
  const ctx = {
    get: record('get'),
    head: record('head'),
    delete: record('delete'),
    post: record('post'),
    put: record('put'),
    patch: record('patch'),
  }
  return { ctx, calls }
}

describe('staging gate: reads retried on a reset connection', () => {
  it('retries GET, HEAD and DELETE', async () => {
    const { ctx, calls } = fakeContext()
    withRetriedReads(ctx as any)
    await ctx.get('/a', { params: { x: 1 } })
    await ctx.head('/a')
    await ctx.delete('/a')
    expect(calls).toEqual([
      { method: 'get', options: { maxRetries: READ_RETRIES, params: { x: 1 } } },
      { method: 'head', options: { maxRetries: READ_RETRIES } },
      { method: 'delete', options: { maxRetries: READ_RETRIES } },
    ])
  })

  it('never resends a write', async () => {
    const { ctx, calls } = fakeContext()
    withRetriedReads(ctx as any)
    await ctx.post('/a', { data: {} })
    await ctx.put('/a')
    await ctx.patch('/a')
    expect(calls.every((c) => !c.options?.maxRetries)).toBe(true)
  })

  it("keeps a caller's own maxRetries", async () => {
    const { ctx, calls } = fakeContext()
    withRetriedReads(ctx as any)
    await ctx.get('/a', { maxRetries: 0 })
    expect(calls[0].options.maxRetries).toBe(0)
  })

  it('the QA API context every journey uses is wrapped', () => {
    const src = readFileSync(join(__dirname, '../../tests/staging/support/qa-api.ts'), 'utf8')
    expect(src).toMatch(/return withRetriedReads\(\s*await request\.newContext\(/)
  })
})
