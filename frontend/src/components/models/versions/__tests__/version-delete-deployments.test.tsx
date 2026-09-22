import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { QueryClient } from '@tanstack/react-query'

import { render } from '../../../../test/setup'
import { VersionsTab } from '../../versions-tab'
import { makeVersion } from '../../deployments/__tests__/fixtures'

// The page derives its "N deployments" count for the selected version
// from the deployments rows, and deleting a version releases them, but
// the delete only ever invalidated ['model-versions', orgId].

vi.mock('../../../../lib/deployments-api', async () => {
  const actual = await vi.importActual<typeof import('../../../../lib/deployments-api')>('../../../../lib/deployments-api')
  return {
    ...actual,
    modelVersionsApi: { list: vi.fn(), get: vi.fn(), create: vi.fn(), delete: vi.fn() },
    modelDeploymentsApi: { list: vi.fn(), get: vi.fn(), create: vi.fn(), scale: vi.fn(), teardown: vi.fn(), delete: vi.fn() },
    modelAdaptersApi: { list: vi.fn() },
  }
})
vi.mock('../../../../lib/api', () => ({
  credentialsApi: { getAll: vi.fn().mockResolvedValue([]) },
  budgetsApi: { list: vi.fn().mockResolvedValue([]) },
}))
vi.mock('../../../../store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'test-org-id', name: 'Test Org' } }),
}))
vi.mock('../../../../store/app', () => ({
  useNotifications: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))

import { modelDeploymentsApi, modelVersionsApi, modelAdaptersApi } from '../../../../lib/deployments-api'

describe('deleting a model version', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    vi.clearAllMocks()
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    ;(modelAdaptersApi.list as any).mockResolvedValue([])
    ;(modelDeploymentsApi.list as any).mockResolvedValue([])
    ;(modelVersionsApi.delete as any).mockResolvedValue(undefined)
    ;(modelVersionsApi.list as any).mockResolvedValue([makeVersion()])
  })

  it('also refetches the deployments rows the count is derived from', async () => {
    render(<VersionsTab />, { queryClient })

    fireEvent.click(await screen.findByText('support-bot-v3'))
    await waitFor(() => expect(modelDeploymentsApi.list).toHaveBeenCalled())
    const before = (modelDeploymentsApi.list as any).mock.calls.length

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' }).at(-1)!)

    await waitFor(() => expect(modelVersionsApi.delete).toHaveBeenCalledWith('v-1'))
    await waitFor(() =>
      expect((modelDeploymentsApi.list as any).mock.calls.length).toBeGreaterThan(before),
    )
  })
})
