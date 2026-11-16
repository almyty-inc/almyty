import { describe, it, expect, vi, afterEach } from 'vitest'

import { api, toolsApi } from '../api'
import { toolRunOutcome } from '../tool-run-outcome'

/**
 * Testing an Open-Meteo tool with a latitude out of range showed a green
 * "Success" with the upstream's 400 body as the result. The backend answers
 * HTTP 200 { success: false, data: <upstream body>, error }, and the tools
 * API used to hand the page only `data`, so the failure was lost.
 */
const UPSTREAM_400 = {
  success: false,
  data: { reason: 'Latitude must be in range of -90 to 90°. Given: 91.0.', error: true },
  error: 'Request failed with status code 400',
  message: 'Tool execution failed',
  metadata: { executionTime: 120, httpStatus: 400, url: '/v1/forecast', method: 'GET' },
}

afterEach(() => vi.restoreAllMocks())

describe('toolsApi.execute', () => {
  it('keeps the whole answer, so a failed run still says success:false', async () => {
    vi.spyOn(api, 'post').mockResolvedValue({ data: UPSTREAM_400 } as any)

    const res = await toolsApi.execute('tool-1', { parameters: { latitude: '91' } }, 'org-1')

    expect(res.success).toBe(false)
    expect(res.data).toEqual(UPSTREAM_400.data)
    expect(res.metadata?.httpStatus).toBe(400)
  })
})

describe('toolRunOutcome', () => {
  it('reads an upstream 400 as a failure with its status and body', () => {
    const outcome = toolRunOutcome(UPSTREAM_400)

    expect(outcome.success).toBe(false)
    expect(outcome.error).toBe('Request failed with status code 400')
    expect(outcome.statusCode).toBe(400)
    expect(outcome.fullError).toEqual(UPSTREAM_400.data)
  })

  it('reads an upstream 404 as a failure', () => {
    const outcome = toolRunOutcome({ success: false, data: 'Not Found', error: 'Request failed with status code 404', metadata: { httpStatus: 404 } })

    expect(outcome.success).toBe(false)
    expect(outcome.statusCode).toBe(404)
  })

  it('reads a successful run as a success and keeps its data', () => {
    const outcome = toolRunOutcome({ success: true, data: { daily: { time: ['2026-11-13'] } }, metadata: { executionTime: 80, httpStatus: 200 } })

    expect(outcome.success).toBe(true)
    expect(outcome.data).toEqual({ daily: { time: ['2026-11-13'] } })
    expect(outcome.metadata?.executionTime).toBe(80)
  })

  it('never reads an answer without a success flag as a success', () => {
    expect(toolRunOutcome({ daily: {} } as any).success).toBe(false)
    expect(toolRunOutcome(undefined).success).toBe(false)
  })
})
