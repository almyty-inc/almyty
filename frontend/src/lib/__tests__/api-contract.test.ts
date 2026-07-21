import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Contract regression tests for lib/api.ts — guards against the class of
 * bug where a typed *Api helper builds a URL / method that no backend
 * route matches (silent 404 / 405 in production).
 *
 * We spy on the underlying axios instance's verb methods and assert the
 * exact path + HTTP verb each helper issues, then compare against the
 * backend route table. These caught three live defects:
 *
 *  1. mcpSourcesApi built `/organizations//mcp-sources` — the org id and
 *     source id were never interpolated, so every call 404'd. The tools
 *     page "MCP servers" panel was fully broken.
 *  2. organizationsApi.updateMemberRole issued PATCH, but the backend only
 *     exposes PUT `/organizations/:id/members/:userId` — role changes 404'd.
 *  3. interfacesApi / agentsApi.getInterfaces hit `/interfaces`, a
 *     controller that was deleted when the module merged into gateways.
 *     Removed; the agent-detail interfaces tab reads gateways directly.
 */

import { api, mcpSourcesApi, organizationsApi } from '../api'

// Each verb resolves to the axios envelope shape the helpers unwrap.
function envelope(data: unknown = { ok: true }) {
  return Promise.resolve({ data: { success: true, data } })
}

let getSpy: ReturnType<typeof vi.spyOn>
let postSpy: ReturnType<typeof vi.spyOn>
let putSpy: ReturnType<typeof vi.spyOn>
let patchSpy: ReturnType<typeof vi.spyOn>
let deleteSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  getSpy = vi.spyOn(api, 'get').mockImplementation(() => envelope() as any)
  postSpy = vi.spyOn(api, 'post').mockImplementation(() => envelope() as any)
  putSpy = vi.spyOn(api, 'put').mockImplementation(() => envelope() as any)
  patchSpy = vi.spyOn(api, 'patch').mockImplementation(() => envelope() as any)
  deleteSpy = vi.spyOn(api, 'delete').mockImplementation(() => envelope() as any)
})

describe('mcpSourcesApi — org + source ids must be interpolated', () => {
  const orgId = 'org-123'
  const sourceId = 'src-456'

  it('getAll targets /organizations/:orgId/mcp-sources', async () => {
    await mcpSourcesApi.getAll(orgId)
    expect(getSpy).toHaveBeenCalledWith(
      `/organizations/${orgId}/mcp-sources`,
      undefined,
    )
  })

  it('create targets /organizations/:orgId/mcp-sources', async () => {
    await mcpSourcesApi.create(orgId, { name: 'n', url: 'https://x' })
    expect(postSpy).toHaveBeenCalledWith(
      `/organizations/${orgId}/mcp-sources`,
      { name: 'n', url: 'https://x' },
      undefined,
    )
  })

  it('sync targets /organizations/:orgId/mcp-sources/:id/sync', async () => {
    await mcpSourcesApi.sync(orgId, sourceId)
    expect(postSpy).toHaveBeenCalledWith(
      `/organizations/${orgId}/mcp-sources/${sourceId}/sync`,
      undefined,
      undefined,
    )
  })

  it('delete targets /organizations/:orgId/mcp-sources/:id', async () => {
    await mcpSourcesApi.delete(orgId, sourceId)
    expect(deleteSpy).toHaveBeenCalledWith(
      `/organizations/${orgId}/mcp-sources/${sourceId}`,
      undefined,
    )
  })

  it('never emits an empty path segment', async () => {
    await mcpSourcesApi.getAll(orgId)
    await mcpSourcesApi.create(orgId, { name: 'n', url: 'https://x' })
    await mcpSourcesApi.sync(orgId, sourceId)
    await mcpSourcesApi.delete(orgId, sourceId)
    const urls = [
      ...getSpy.mock.calls,
      ...postSpy.mock.calls,
      ...deleteSpy.mock.calls,
    ].map((c) => c[0] as string)
    for (const url of urls) {
      expect(url).not.toMatch(/\/\//) // no `//` double slash
    }
  })
})

describe('organizationsApi.updateMemberRole — PUT to match backend', () => {
  it('issues PUT /organizations/:id/members/:userId', async () => {
    await organizationsApi.updateMemberRole('org-1', 'user-9', { role: 'admin' })
    expect(putSpy).toHaveBeenCalledWith(
      '/organizations/org-1/members/user-9',
      { role: 'admin' },
      undefined,
    )
    // Must NOT use PATCH — the backend has no PATCH route for this path.
    expect(patchSpy).not.toHaveBeenCalled()
  })
})
