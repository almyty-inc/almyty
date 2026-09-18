import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { render } from '../../test/setup'
import { ToolDetailPage } from '../tool-detail'
import { toolsApi } from '../../lib/api'

// Activating a draft tool with no code, or one the caller cannot reach,
// is refused by the backend. The toggle mutation had an onSuccess and no
// onError at all, so a refusal stopped the spinner, left the badge on
// Draft and said nothing -- indistinguishable from a dead switch.

vi.mock('../../lib/api', () => ({
  toolsApi: {
    getById: vi.fn(),
    activate: vi.fn(),
    deactivate: vi.fn(),
    execute: vi.fn(),
  },
  workspacesApi: { getAll: vi.fn() },
}))

const notifyError = vi.fn()
const notifySuccess = vi.fn()
vi.mock('../../store/app', () => ({
  useNotifications: () => ({
    success: notifySuccess,
    error: notifyError,
    info: vi.fn(),
    warning: vi.fn(),
  }),
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
    useLocation: () => ({ pathname: '/tools/tool-1', search: '', hash: '', state: null }),
  }
})

const DRAFT_TOOL = {
  id: 'tool-1',
  name: 'Draft Tool',
  type: 'javascript',
  status: 'draft',
  description: 'Not finished',
  parameters: {},
}

describe('ToolDetailPage activation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(toolsApi.getById).mockResolvedValue(DRAFT_TOOL as any)
  })

  it('says why an activation was refused instead of silently reverting', async () => {
    vi.mocked(toolsApi.activate).mockRejectedValue({
      response: {
        status: 400,
        data: { error: { code: 'TOOL_NOT_EXECUTABLE', message: 'This tool has no code to run yet.' } },
      },
    })

    const user = userEvent.setup()
    render(<ToolDetailPage />)

    const toggle = await screen.findByRole('switch', { name: 'Activate tool' })
    await user.click(toggle)

    await waitFor(() => expect(toolsApi.activate).toHaveBeenCalled())
    await waitFor(() =>
      expect(notifyError).toHaveBeenCalledWith(
        'Could not activate tool',
        'This tool has no code to run yet.',
      ),
    )
    expect(notifySuccess).not.toHaveBeenCalled()
  })

  it('still reports a successful activation', async () => {
    vi.mocked(toolsApi.activate).mockResolvedValue({ ...DRAFT_TOOL, status: 'active' } as any)

    const user = userEvent.setup()
    render(<ToolDetailPage />)

    await user.click(await screen.findByRole('switch', { name: 'Activate tool' }))

    await waitFor(() => expect(notifySuccess).toHaveBeenCalled())
    expect(notifyError).not.toHaveBeenCalled()
  })
})
