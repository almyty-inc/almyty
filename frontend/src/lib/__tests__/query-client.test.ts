import { readFileSync } from 'fs'
import { resolve } from 'path'
import { MutationObserver } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '../query-client'

describe('createQueryClient', () => {
  it('runs a failed mutation once: a POST is never replayed behind the caller', async () => {
    const client = createQueryClient()
    const mutationFn = vi.fn().mockRejectedValue(Object.assign(new Error('Request failed with status code 400'), { response: { status: 400 } }))
    const observer = new MutationObserver(client, { mutationFn })
    await expect(observer.mutate()).rejects.toThrow('400')
    expect(mutationFn).toHaveBeenCalledTimes(1)
  })

  it('still lets a mutation that is safe to repeat opt in', async () => {
    const client = createQueryClient()
    const mutationFn = vi.fn().mockRejectedValueOnce(new Error('flaky')).mockResolvedValueOnce('ok')
    const observer = new MutationObserver(client, { mutationFn, retry: 1, retryDelay: 0 })
    await expect(observer.mutate()).resolves.toBe('ok')
    expect(mutationFn).toHaveBeenCalledTimes(2)
  })

  it('is the client the app runs on', () => {
    const main = readFileSync(resolve(__dirname, '../../main.tsx'), 'utf8')
    expect(main).toContain('createQueryClient()')
    expect(main).not.toMatch(/new QueryClient\(/)
  })
})
