import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'

import { render } from '../../../test/setup'
import { statusColors, TABLE_HEAD_CLASS } from '../constants'

/**
 * The analytics palette used to be half a palette.
 *
 * `protocolColors` was dark-only (`text-violet-300`, no light half), so
 * in light mode an MCP badge was unreadable; the HTTP status colours
 * were the mirror image (`text-green-600`, no dark half). There is one
 * canonical protocol map — ProtocolBadge — and the tabs now render it
 * rather than keeping a second copy that can drift again.
 */

vi.mock('@/lib/api', () => ({
  analyticsApi: { getGatewayUsage: vi.fn(), getRequestLogs: vi.fn() },
  gatewaysApi: { getAll: vi.fn() },
}))

vi.mock('@/store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'org-1', name: 'Acme' } }),
}))

import { analyticsApi, gatewaysApi } from '@/lib/api'
import { GatewaysTab } from '../gateways-tab'

const fn = (f: unknown) => f as unknown as ReturnType<typeof vi.fn>

describe('the analytics palette carries both themes', () => {
  beforeEach(() => vi.clearAllMocks())

  it('gives every HTTP status class a dark half', () => {
    const entries = Object.entries(statusColors)
    expect(entries.length).toBeGreaterThan(0)
    for (const [bucket, cls] of entries) {
      expect(cls, `status ${bucket}xx`).toMatch(/\btext-\w+-600\b/)
      expect(cls, `status ${bucket}xx`).toMatch(/\bdark:text-\w+-400\b/)
    }
  })

  it('renders a protocol badge with both halves rather than the dark-only map', async () => {
    fn(gatewaysApi.getAll).mockResolvedValue([{ id: 'g1', name: 'Prod MCP', type: 'mcp' }])
    fn(analyticsApi.getGatewayUsage).mockResolvedValue([
      { gatewayId: 'g1', totalRequests: 10, successCount: 9, errorCount: 1, successRate: 90 },
    ])

    render(<GatewaysTab />)

    const badge = await screen.findByText('MCP')
    // The light half is what was missing: violet-700 on violet-100.
    expect(badge.className).toContain('bg-violet-100')
    expect(badge.className).toContain('text-violet-700')
    expect(badge.className).toContain('dark:text-violet-300')
  })

  it('uses the shared table header style, not a local one', async () => {
    fn(gatewaysApi.getAll).mockResolvedValue([])
    fn(analyticsApi.getGatewayUsage).mockResolvedValue([
      { gatewayId: 'g1', totalRequests: 10, successCount: 9, errorCount: 1, successRate: 90 },
    ])

    render(<GatewaysTab />)

    // Same shape as TableHead in components/ui/table.tsx, so the eight
    // hand-rolled analytics tables no longer each pick their own density.
    expect(TABLE_HEAD_CLASS).toContain('h-12')
    expect(TABLE_HEAD_CLASS).toContain('uppercase')
    const header = await screen.findByText('Gateway')
    expect(header.className).toBe(TABLE_HEAD_CLASS)
  })
})
