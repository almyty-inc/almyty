import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'

import { render } from '../../test/setup'
import { OrganizationsPage } from '../organizations'
import { organizationsApi } from '../../lib/api'

// Regression for #129: organizationsApi.getAll() runs through
// apiGet → extractData so the resolved value already IS the array.
// The page used to read organizationsData?.data || organizations
// which was undefined for the array case and fell through to the
// Zustand-store fallback whose entries miss createdAt and isActive
// — that's why the table rendered "Invalid Date" and "Inactive"
// for the active org.

vi.mock('../../lib/api', () => ({
  organizationsApi: {
    getAll: vi.fn(),
    getMembers: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    addMember: vi.fn(),
    removeMember: vi.fn(),
    updateMemberRole: vi.fn(),
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
    currentOrganization: { id: 'current-org', name: 'Current' },
    organizations: [],
    setCurrentOrganization: vi.fn(),
  }),
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useLocation: () => ({ pathname: '/organizations', search: '', hash: '', state: null }),
  }
})

describe('OrganizationsPage', () => {
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

  it('renders the org row with its real name when given a flat array (post-extractData)', async () => {
    ;(organizationsApi.getAll as any).mockResolvedValue([
      {
        id: 'org-1',
        name: 'fresh-org-test',
        slug: 'fresh-org-test',
        description: 'Test org',
        isActive: true,
        plan: 'free',
        createdAt: '2026-06-01T12:17:57.470Z',
        updatedAt: '2026-06-02T00:00:00.000Z',
      },
    ])

    render(<OrganizationsPage />)

    await waitFor(() => {
      expect(screen.getByText('fresh-org-test')).toBeInTheDocument()
    })
    // The pre-fix behavior rendered "Invalid Date" because we fell
    // through to a Zustand-store fallback with no createdAt field.
    expect(screen.queryByText('Invalid Date')).not.toBeInTheDocument()
  })
})
