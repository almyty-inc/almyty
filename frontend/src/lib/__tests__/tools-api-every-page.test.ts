import { describe, it, expect, vi, beforeEach } from 'vitest'

import { api } from '../api'
import { toolsApi } from '../api'

/**
 * The tool pickers (an agent's Tools and APIs, a gateway, a tool step) list
 * every tool of the organization. The server answers at most 100 a page,
 * so Gmail (79 tools) and Google Calendar (37) showed 7 of Calendar's
 * tools, and an agent could not be given the rest.
 */
const tool = (i: number) => ({ id: `t${i}`, name: `tool_${i}` })

function page(n: number, total: number, limit = 100) {
  const from = (n - 1) * limit
  const tools = Array.from({ length: Math.max(0, Math.min(limit, total - from)) }, (_, i) => tool(from + i))
  return Promise.resolve({ data: { success: true, data: { tools, total, page: n, limit, totalPages: Math.ceil(total / limit) } } })
}

let getSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  getSpy = vi.spyOn(api, 'get')
})

describe('toolsApi.getAll', () => {
  it('reads every page when no page is asked for', async () => {
    getSpy.mockImplementation(((_url: string, config: any) => page(config.params.page, 130)) as any)

    const res: any = await toolsApi.getAll('org-1')

    expect(res.tools).toHaveLength(130)
    expect(res.total).toBe(130)
    expect(res.tools.map((t: any) => t.id)).toContain('t129')
    expect(getSpy).toHaveBeenCalledTimes(2)
    expect(getSpy).toHaveBeenCalledWith('/organizations/org-1/tools', { params: { limit: 100, page: 2 } })
  })

  it('makes one request when everything fits on a page', async () => {
    getSpy.mockImplementation(((_url: string, config: any) => page(config.params.page, 14)) as any)

    const res: any = await toolsApi.getAll('org-1')

    expect(res.tools).toHaveLength(14)
    expect(getSpy).toHaveBeenCalledTimes(1)
  })

  it('reads only the page asked for', async () => {
    getSpy.mockImplementation(((_url: string, config: any) => page(config.params.page, 130, config.params.limit)) as any)

    const res: any = await toolsApi.getAll('org-1', { limit: 25, page: 2 })

    expect(res.tools).toHaveLength(25)
    expect(getSpy).toHaveBeenCalledTimes(1)
  })
})
