import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'

import { render } from '../../test/setup'
import { LlmProvidersPage } from '../llm-providers'
import { llmProvidersApi } from '@/lib/api'

// A hosted model gets a provider row written for it by the reconcile loop
// (metadata.managedBy.kind model_endpoint). The API returns it, because the
// model picker calls the hosted model through it, but it is not an
// inference provider anyone added, so this page leaves it out.

vi.mock('@/lib/api', () => ({
  llmProvidersApi: { getAll: vi.fn(), delete: vi.fn(), update: vi.fn() },
  organizationsApi: { getTeams: vi.fn().mockResolvedValue([]) },
}))

vi.mock('@/store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'org-1', name: 'Org' } }),
}))

vi.mock('@/store/app', () => ({
  useNotifications: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))

const ADDED = { id: 'p1', name: 'Team OpenAI', type: 'openai', status: 'active', totalRequests: 2 }
const HOSTED = {
  id: 'p2', name: 'Qwen on Modal', type: 'openai', status: 'active', totalRequests: 5,
  metadata: { managedBy: { kind: 'model_endpoint', id: 'd-1' } },
}

describe('LlmProvidersPage hosted-model rows', () => {
  beforeEach(() => vi.clearAllMocks())

  it('lists the providers people added and not the rows hosted models run through', async () => {
    vi.mocked(llmProvidersApi.getAll).mockResolvedValue([ADDED, HOSTED] as any)
    render(<LlmProvidersPage />)
    await screen.findByText('Team OpenAI')
    expect(screen.queryByText('Qwen on Modal')).toBeNull()
    // The header counts only what is listed.
    expect(screen.getByText(/1 provider \(1 active\)/)).toBeInTheDocument()
    expect(screen.getByText(/2 requests/)).toBeInTheDocument()
  })

  it('shows the empty state when the only rows belong to hosted models', async () => {
    vi.mocked(llmProvidersApi.getAll).mockResolvedValue([HOSTED] as any)
    render(<LlmProvidersPage />)
    expect(await screen.findByText('No inference providers yet')).toBeInTheDocument()
    expect(screen.queryByText('Qwen on Modal')).toBeNull()
  })
})
