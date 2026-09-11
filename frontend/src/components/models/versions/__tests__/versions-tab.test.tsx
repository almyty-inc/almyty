import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'

import { render } from '../../../../test/setup'
import { VersionsTab } from '../../versions-tab'
import { makeDeployment, makeVersion } from '../../deployments/__tests__/fixtures'

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
const notify = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
vi.mock('../../../../store/app', () => ({ useNotifications: () => notify }))

import { modelDeploymentsApi, modelVersionsApi, modelAdaptersApi } from '../../../../lib/deployments-api'

const versionsList = modelVersionsApi.list as ReturnType<typeof vi.fn>
const versionsDelete = modelVersionsApi.delete as ReturnType<typeof vi.fn>
const deploymentsList = modelDeploymentsApi.list as ReturnType<typeof vi.fn>

describe('VersionsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(modelAdaptersApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([])
    deploymentsList.mockResolvedValue([])
    versionsDelete.mockResolvedValue(undefined)
  })

  it('lists tracked artifacts with name, base, URI, size and quantizations', async () => {
    versionsList.mockResolvedValue([makeVersion(), makeVersion({ id: 'v-2', name: 'tiny', base: 'llama-3b', registryUri: 'file:///models/tiny@sha1', sizeBytes: null, quantizations: [] })])
    render(<VersionsTab />)
    expect(await screen.findByText('support-bot-v3')).toBeInTheDocument()
    expect(screen.getByText('qwen3-14b')).toBeInTheDocument()
    expect(screen.getByText('hf://acme/support-bot-v3@e3b0c442')).toBeInTheDocument()
    expect(screen.getByText('27.0 GB')).toBeInTheDocument()
    expect(screen.getByText('awq-int4')).toBeInTheDocument()
    expect(screen.getByText('tiny')).toBeInTheDocument()
  })

  it('says plainly in the empty state that most people never need this', async () => {
    versionsList.mockResolvedValue([])
    const { unmount } = render(<VersionsTab />)
    expect(await screen.findByText('Nothing tracked here, and most people never need this')).toBeInTheDocument()
    expect(screen.getByText(/To run a model you only have to name it on a deployment/)).toBeInTheDocument()
    unmount()
    versionsList.mockRejectedValue(new Error('registry down'))
    render(<VersionsTab />)
    expect(await screen.findByText("We couldn't load versions")).toBeInTheDocument()
    expect(screen.getByText('registry down')).toBeInTheDocument()
  })

  it('opens the detail with the manifest summary and deletes after confirm', async () => {
    versionsList.mockResolvedValue([makeVersion({ metadata: { scheme: 's3', manifest: { license: 'Apache-2.0', tokenizer: 'hf://Qwen/Qwen3-14B', created: '2026-09-08T09:00:00Z', fileCount: 3, chatTemplate: 'chatml' } } })])
    render(<VersionsTab />)
    fireEvent.click(await screen.findByText('support-bot-v3'))
    expect(await screen.findByText('Apache-2.0')).toBeInTheDocument()
    expect(screen.getByText('3 files')).toBeInTheDocument()
    expect(screen.getByText('chatml')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(await screen.findByText('Delete support-bot-v3?')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' }).at(-1)!)
    await waitFor(() => expect(versionsDelete).toHaveBeenCalledWith('v-1'))
    await waitFor(() => expect(notify.success).toHaveBeenCalledWith('Version deleted', expect.any(String)))
  })

  it('blocks delete while any deployment other than torn_down points at the version', async () => {
    versionsList.mockResolvedValue([makeVersion()])
    const tracked = { modelVersionId: 'v-1', modelRef: null }
    deploymentsList.mockResolvedValue([
      makeDeployment({ ...tracked, state: 'ready' }),
      makeDeployment({ ...tracked, id: 'd-failed', state: 'failed' }),
      makeDeployment({ ...tracked, id: 'd-old', state: 'torn_down' }),
    ])
    render(<VersionsTab />)
    fireEvent.click(await screen.findByText('support-bot-v3'))
    await screen.findByText(/2 deployments point at this version/)
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled()
  })

  it('explains a missing manifest for hub and local URIs', async () => {
    versionsList.mockResolvedValue([makeVersion({ registryUri: 'hf://Qwen/Qwen3-14B@abc', metadata: { scheme: 'hf', manifest: null } })])
    render(<VersionsTab />)
    fireEvent.click(await screen.findByText('support-bot-v3'))
    expect(await screen.findByText(/No almyty-manifest.json at this URI/)).toBeInTheDocument()
  })
})
