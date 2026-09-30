import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'

import { render } from '../../test/setup'
import { ToolDetailPage } from '../tool-detail'
import { toolsApi, workspacesApi } from '../../lib/api'

// A runner method that runs inside a workspace needs one picked on the Test
// tab. Nobody creates a workspace by hand: an agent run that calls the tool
// gets one automatically, and the runner's Workspaces tab lists and releases
// them. The copy used to say a workspace was made only through the API.

vi.mock('../../lib/api', () => ({
  toolsApi: { getById: vi.fn(), activate: vi.fn(), deactivate: vi.fn(), execute: vi.fn() },
  workspacesApi: { getAll: vi.fn() },
}))

vi.mock('../../store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'org-1', name: 'Org' } }),
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useParams: () => ({ id: 'tool-1' }),
    useSearchParams: () => [new URLSearchParams('tab=test'), vi.fn()],
    useLocation: () => ({ pathname: '/tools/tool-1', search: '?tab=test', hash: '', state: null }),
  }
})

const RUNNER_TOOL = {
  id: 'tool-1',
  name: 'runner.laptop.shell.exec',
  type: 'runner',
  status: 'active',
  parameters: {},
  runnerConfig: { runnerId: 'runner-1', method: 'shell.exec', requiresWorkspace: true },
}

describe('ToolDetailPage workspace picker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(toolsApi.getById).mockResolvedValue(RUNNER_TOOL as any)
    vi.mocked(workspacesApi.getAll).mockResolvedValue([] as any)
  })

  it('with no active workspace, says agent runs get one automatically', async () => {
    render(<ToolDetailPage />)

    const empty = await screen.findByText(/No active workspaces on this runner/)
    expect(empty).toHaveTextContent('An agent run that calls this tool gets one automatically')
    expect(empty).not.toHaveTextContent('POST /workspaces')
    expect(document.body).not.toHaveTextContent(/to create one|create a new workspace from the runner page/i)
  })
})
