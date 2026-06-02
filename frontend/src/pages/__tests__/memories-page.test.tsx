import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'

import { render } from '../../test/setup'
import { MemoriesPage } from '../memories'
import { memoriesApi } from '../../lib/api'

// Regression for #108. memoriesApi.list() goes through apiPost which
// already extracts the {success, data} envelope to the raw payload
// (`{items, next_cursor}`). The page used to read
// list.data?.data?.items — the second `.data` was always undefined,
// so even when the API returned rows the page rendered the empty
// state ("No memory items"). The fix dropped the extra hop to
// list.data?.items; this test pins that path.

vi.mock('../../lib/api', () => ({
  memoriesApi: {
    list: vi.fn(),
    search: vi.fn(),
    put: vi.fn(),
    remove: vi.fn(),
    supersede: vi.fn(),
    listBackends: vi.fn(),
    backendsHealth: vi.fn(),
    getConfig: vi.fn(),
    updateConfig: vi.fn(),
    getById: vi.fn(),
    transfer: vi.fn(),
    listAudit: vi.fn(),
    listCredentials: vi.fn(),
    runConsolidation: vi.fn(),
  },
}))

vi.mock('../../store/app', () => ({
  useNotifications: () => ({
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
}))

vi.mock('../../store/organization', () => ({
  useOrganizationStore: () => ({
    currentOrganization: { id: 'org-test' },
  }),
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useLocation: () => ({ pathname: '/memories', search: '', hash: '', state: null }),
  }
})

describe('MemoriesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    if (!Element.prototype.hasPointerCapture) {
      Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
      Element.prototype.setPointerCapture = vi.fn()
      Element.prototype.releasePointerCapture = vi.fn()
    }
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = vi.fn()
    }
  })

  it('renders a memory item when memoriesApi.list returns the post-extractData {items} shape', async () => {
    ;(memoriesApi.list as any).mockResolvedValue({
      items: [
        {
          id: 'mem-1',
          content: 'The user prefers Yosemite over Yellowstone for camping trips.',
          tier: 'long',
          mode: 'memory',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          tags: [],
          metadata: {},
          scope: { scope_type: 'org', scope_id: 'org-test' },
        },
      ],
      next_cursor: null,
    })
    ;(memoriesApi.listBackends as any).mockResolvedValue([])
    ;(memoriesApi.backendsHealth as any).mockResolvedValue([])
    ;(memoriesApi.getConfig as any).mockResolvedValue({})

    render(<MemoriesPage />)

    await waitFor(() => {
      expect(
        screen.getByText('The user prefers Yosemite over Yellowstone for camping trips.'),
      ).toBeInTheDocument()
    })
  })
})
