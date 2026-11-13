import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'

import { render } from '../../test/setup'
import { ToolDetailPage } from '../tool-detail'
import { toolsApi, workspacesApi } from '../../lib/api'

// The Test tab showed a green "Success" and a "Tool executed" toast when the
// upstream answered 404 or 400: the run's success:false never reached it.

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

const TOOL = { id: 'tool-1', name: 'get_v1_forecast', type: 'api', status: 'active', parameters: {} }

describe('ToolDetailPage test run', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(toolsApi.getById).mockResolvedValue(TOOL as any)
    vi.mocked(workspacesApi.getAll).mockResolvedValue([] as any)
  })

  it('shows an upstream 400 as an error, not a success', async () => {
    vi.mocked(toolsApi.execute).mockResolvedValue({
      success: false,
      data: { reason: 'Latitude must be in range of -90 to 90°. Given: 91.0.', error: true },
      error: 'Request failed with status code 400',
      metadata: { httpStatus: 400 },
    })
    render(<ToolDetailPage />)

    fireEvent.click(await screen.findByRole('button', { name: /Execute Tool/ }))

    expect(await screen.findByText('Execution failed')).toBeInTheDocument()
    expect(screen.queryByText('Success')).not.toBeInTheDocument()
    expect(document.body).toHaveTextContent('Request failed with status code 400')
    expect(document.body).toHaveTextContent('Latitude must be in range')
  })

  it('shows a successful run with its data', async () => {
    vi.mocked(toolsApi.execute).mockResolvedValue({ success: true, data: { daily: { temperature_2m_max: [12.3] } }, metadata: { executionTime: 42 } })
    render(<ToolDetailPage />)

    fireEvent.click(await screen.findByRole('button', { name: /Execute Tool/ }))

    expect(await screen.findByText('Success')).toBeInTheDocument()
    expect(document.body).toHaveTextContent('temperature_2m_max')
    expect(document.body).toHaveTextContent('Executed in 42ms')
  })
})
