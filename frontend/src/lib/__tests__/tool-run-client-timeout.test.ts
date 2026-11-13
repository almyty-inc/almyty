import { describe, it, expect, vi } from 'vitest'

/**
 * A tool run waits as long as the tool's own timeout on the server (30 s
 * by default, up to 5 minutes). The browser used the client-wide 30 s,
 * so it gave up at the very moment the server's default deadline fired:
 * a gRPC call to an unreachable server showed as a network timeout and
 * the server's answer ("couldn't reach host:port within 30 s") was lost.
 */

import { api, toolsApi, TOOL_RUN_CLIENT_TIMEOUT_MS } from '../api'

const MAX_TOOL_TIMEOUT_MS = 300_000

describe('toolsApi.execute waits longer than any tool timeout', () => {
  it('posts with its own timeout, above the longest a tool may have', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: { success: true, data: {} } } as any)
    await toolsApi.execute('tool-1', { parameters: {} }, 'org-1')
    expect(post).toHaveBeenCalledWith(
      '/organizations/org-1/tools/tool-1/execute',
      { parameters: {} },
      { timeout: TOOL_RUN_CLIENT_TIMEOUT_MS },
    )
    expect(TOOL_RUN_CLIENT_TIMEOUT_MS).toBeGreaterThan(MAX_TOOL_TIMEOUT_MS)
    post.mockRestore()
  })
})
