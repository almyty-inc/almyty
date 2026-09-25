/**
 * Create and configure flows live on real pages, not in dialogs. The
 * entry points on the APIs and Tools lists navigate there.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { render } from '../../test/setup'
import { ApisPage } from '../apis'
import { ToolsPage } from '../tools'
import { apisApi, toolsApi } from '../../lib/api'

const navigate = vi.fn()

vi.mock('../../lib/api', () => ({
  toolsApi: { getAll: vi.fn(), activate: vi.fn() },
  llmProvidersApi: { getAll: vi.fn().mockResolvedValue([]) },
  apisApi: { getAll: vi.fn(), delete: vi.fn(), generateTools: vi.fn(), testConnection: vi.fn() },
  organizationsApi: { getTeams: vi.fn().mockResolvedValue([]) },
  gatewaysApi: { getAll: vi.fn().mockResolvedValue([]) },
  onboardingApi: { seedSample: vi.fn() },
}))

const ORG = { id: 'org-1', name: 'Org' }
vi.mock('../../store/organization', () => {
  const useOrganizationStore: any = () => ({ currentOrganization: ORG })
  useOrganizationStore.getState = () => ({ currentOrganization: ORG })
  return { useOrganizationStore }
})

vi.mock('../../store/app', () => ({
  useNotifications: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<any>('react-router-dom')
  return {
    ...actual,
    useNavigate: () => navigate,
    useParams: () => ({}),
    useSearchParams: () => [new URLSearchParams(), vi.fn()],
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(toolsApi.getAll).mockResolvedValue({ tools: [], total: 0 } as any)
  vi.mocked(apisApi.getAll).mockResolvedValue({ apis: [], total: 0 } as any)
})

describe('create flows are pages', () => {
  // The entry points are links to the create page (open in a new tab,
  // copy the address), and clicking one opens no dialog.
  it('"Connect an API" links to /apis/new instead of opening a dialog', async () => {
    const user = userEvent.setup()
    render(<ApisPage />)

    const links = await screen.findAllByRole('link', { name: 'Connect an API' })
    for (const link of links) expect(link).toHaveAttribute('href', '/apis/new')
    await user.click(links[0])
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('"Create tool" links to /tools/new instead of opening a dialog', async () => {
    const user = userEvent.setup()
    render(<ToolsPage />)

    const links = await screen.findAllByRole('link', { name: 'Create tool' })
    for (const link of links) expect(link).toHaveAttribute('href', '/tools/new')
    await user.click(links[0])
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
