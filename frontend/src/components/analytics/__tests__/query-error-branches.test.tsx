import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'

import { render } from '../../../test/setup'

/**
 * Six analytics tabs used to swallow a failed fetch: none of them
 * destructured `isError`, so a rejected query fell straight through to
 * the "no data yet" branch. A broken request therefore rendered as a
 * calm, healthy-looking empty state with nothing to retry — on the cost
 * and audit tabs, actively misleading ("you spent nothing", "no audit
 * entries").
 *
 * Each case below asserts both halves: the QueryError is shown, AND the
 * empty-state copy is not, because showing the error while still
 * claiming there is no data would be the same bug in a new shape.
 */

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn() },
  apiGet: vi.fn(),
  analyticsApi: {
    getGatewayUsage: vi.fn(),
    getLlmUsage: vi.fn(),
    getToolUsage: vi.fn(),
    getRequestLogs: vi.fn(),
    getAuditSummary: vi.fn(),
  },
  gatewaysApi: { getAll: vi.fn() },
  toolsApi: { getAll: vi.fn() },
  llmProvidersApi: { getAll: vi.fn() },
  agentsApi: { getAll: vi.fn() },
  budgetsApi: { getSpend: vi.fn() },
  providerUsageApi: { getReconciliation: vi.fn(), sync: vi.fn() },
  auditLogsApi: { getAll: vi.fn() },
  auditExportApi: { download: vi.fn() },
}))

vi.mock('@/store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'org-1', name: 'Acme' } }),
}))

vi.mock('@/store/app', () => ({
  useNotifications: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}))

// The export gate is orthogonal to the error branch under test; render
// its children so the audit tab mounts without an entitlement fetch.
vi.mock('@/components/entitlement-gate', () => ({
  EntitlementGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

import {
  analyticsApi,
  gatewaysApi,
  toolsApi,
  llmProvidersApi,
  agentsApi,
  budgetsApi,
  providerUsageApi,
  auditLogsApi,
} from '@/lib/api'

import { GatewaysTab } from '../gateways-tab'
import { LlmTab } from '../llm-tab'
import { ToolsTab } from '../tools-tab'
import { RequestLogTab } from '../request-log-tab'
import { CostTab } from '../cost-tab'
import { AuditTab } from '../audit-tab'

const fn = (f: unknown) => f as unknown as ReturnType<typeof vi.fn>
const boom = () => Promise.reject(new Error('upstream exploded'))

describe('analytics tabs report a failed fetch instead of an empty state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Secondary lookups resolve; only the query under test rejects, so a
    // passing assertion can only come from the branch we added.
    fn(gatewaysApi.getAll).mockResolvedValue([])
    fn(toolsApi.getAll).mockResolvedValue([])
    fn(llmProvidersApi.getAll).mockResolvedValue([])
    fn(agentsApi.getAll).mockResolvedValue([])
    fn(providerUsageApi.getReconciliation).mockResolvedValue({ data: { providers: [] } })
  })

  it('gateways tab', async () => {
    fn(analyticsApi.getGatewayUsage).mockImplementation(boom)
    render(<GatewaysTab />)

    expect(await screen.findByText(/Couldn't load gateway usage/)).toBeInTheDocument()
    expect(screen.queryByText(/No gateway usage data/)).not.toBeInTheDocument()
  })

  it('llm tab', async () => {
    fn(analyticsApi.getLlmUsage).mockImplementation(boom)
    render(<LlmTab />)

    expect(await screen.findByText(/Couldn't load model usage/)).toBeInTheDocument()
    expect(screen.queryByText(/No model usage data/)).not.toBeInTheDocument()
  })

  it('tools tab', async () => {
    fn(analyticsApi.getToolUsage).mockImplementation(boom)
    render(<ToolsTab />)

    expect(await screen.findByText(/Couldn't load tool usage/)).toBeInTheDocument()
    expect(screen.queryByText(/No tool usage data/)).not.toBeInTheDocument()
  })

  it('request log tab', async () => {
    fn(analyticsApi.getRequestLogs).mockImplementation(boom)
    render(<RequestLogTab />)

    expect(await screen.findByText(/Couldn't load the request log/)).toBeInTheDocument()
    expect(screen.queryByText(/No request logs yet/)).not.toBeInTheDocument()
  })

  it('cost tab', async () => {
    fn(budgetsApi.getSpend).mockImplementation(boom)
    render(<CostTab />)

    // "No spend data" for an unreadable ledger is the worst version of
    // this bug: it reads as a fact about the money, not the request.
    expect(await screen.findByText(/Couldn't load spend/)).toBeInTheDocument()
    expect(screen.queryByText(/No spend data/)).not.toBeInTheDocument()
  })

  it('cost tab reconciliation section', async () => {
    fn(budgetsApi.getSpend).mockResolvedValue({ data: { period: 'month', from: '', totalCents: 0, timeseries: [], byAgent: [] } })
    fn(providerUsageApi.getReconciliation).mockImplementation(boom)
    render(<CostTab />)

    expect(await screen.findByText(/Couldn't load the reconciliation/)).toBeInTheDocument()
    expect(screen.queryByText(/No LLM providers configured/)).not.toBeInTheDocument()
  })

  it('audit tab log', async () => {
    fn(analyticsApi.getAuditSummary).mockResolvedValue({
      totals: { today: 0, thisWeek: 0, thisMonth: 0 },
      topUsers: [],
      byResourceType: [],
    })
    fn(auditLogsApi.getAll).mockImplementation(boom)
    render(<AuditTab />)

    expect(await screen.findByText(/Couldn't load the audit log/)).toBeInTheDocument()
    expect(screen.queryByText(/No audit log entries yet/)).not.toBeInTheDocument()
  })

  it('audit tab summary', async () => {
    fn(analyticsApi.getAuditSummary).mockImplementation(boom)
    fn(auditLogsApi.getAll).mockResolvedValue({ data: [], pagination: { page: 1, totalPages: 1, total: 0 } })
    render(<AuditTab />)

    // The summary previously rendered `null` on failure, so the card row
    // simply vanished with no explanation.
    expect(await screen.findByText(/Couldn't load the audit summary/)).toBeInTheDocument()
  })

  it('offers a retry, not just a message', async () => {
    fn(analyticsApi.getToolUsage).mockImplementation(boom)
    render(<ToolsTab />)

    await screen.findByText(/Couldn't load tool usage/)
    expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument()
  })
})
