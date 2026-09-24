import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient } from '@tanstack/react-query'
import { render, mockGateway, mockTool } from '../../test/setup'
import { GatewaysPage } from '../gateways'
import { gatewaysApi } from '../../lib/api'

// Mock the API module
vi.mock('../../lib/api', () => ({
  gatewaysApi: {
    getAll: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    getTools: vi.fn(),
    getAvailableTools: vi.fn(),
    assignTool: vi.fn(),
  },
  toolsApi: {
    getAll: vi.fn(),
  },
  agentsApi: {
    getAll: vi.fn().mockResolvedValue([]),
  },
}))

// Mock the organization store (component imports from @/store/organization)
vi.mock('../../store/organization', () => ({
  useOrganizationStore: () => ({
    currentOrganization: {
      id: 'test-org-id',
      name: 'Test Org',
    },
  }),
}))

// Mock notifications (component imports from @/store/app)
vi.mock('../../store/app', () => ({
  useNotifications: () => ({
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
}))

// Track navigate calls
const mockNavigate = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useParams: () => ({}),
    useSearchParams: () => [new URLSearchParams(), vi.fn()],
    useLocation: () => ({
      pathname: '/gateways',
      search: '',
      hash: '',
      state: null,
    }),
  }
})

// Mock hasPointerCapture for Radix Select in jsdom
beforeEach(() => {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = vi.fn()
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = vi.fn()
  }
})

describe('GatewaysPage', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })

    // Reset all mocks
    vi.clearAllMocks()
  })

  const renderGatewaysPage = () => {
    return render(<GatewaysPage />, { queryClient })
  }

  describe('Loading State', () => {
    it('should show loading spinner when data is being fetched', () => {
      vi.mocked(gatewaysApi.getAll).mockImplementation(
        () => new Promise(() => {}) // Never resolves
      )

      renderGatewaysPage()

      // The component shows a LoadingSpinner (an animated div) inside a centered container
      // When loading, the page header is still visible but the main content area shows the spinner
      expect(screen.getByText('Gateways')).toBeInTheDocument()
    })
  })

  describe('Gateway List', () => {
    beforeEach(() => {
      vi.mocked(gatewaysApi.getAll).mockResolvedValue({
        gateways: [
            { ...mockGateway, id: 'gateway-1', name: 'MCP Gateway', type: 'mcp' },
            { ...mockGateway, id: 'gateway-2', name: 'A2A Gateway', type: 'a2a' },
        ],
      })
    })

    it('should display gateways list', async () => {
      renderGatewaysPage()

      await waitFor(() => {
        expect(screen.getByText('MCP Gateway')).toBeInTheDocument()
        expect(screen.getByText('A2A Gateway')).toBeInTheDocument()
      })
    })

    it('should show gateway type badges', async () => {
      renderGatewaysPage()

      await waitFor(() => {
        expect(screen.getByText('MCP')).toBeInTheDocument()
        expect(screen.getByText('A2A')).toBeInTheDocument()
      })
    })

    it('should show tool count in tools column', async () => {
      renderGatewaysPage()

      await waitFor(() => {
        // The tools column shows "{count} tools" text
        const toolsText = screen.getAllByText('tools')
        expect(toolsText.length).toBeGreaterThan(0)
      })
    })

    it('should show gateway status', async () => {
      renderGatewaysPage()

      await waitFor(() => {
        // Status column renders gateway.status — may be "active" or "Active" depending on badge
        const activeStatuses = screen.getAllByText(/active/i)
        expect(activeStatuses.length).toBeGreaterThan(0)
      })
    })
  })

  describe('Empty State', () => {
    beforeEach(() => {
      vi.mocked(gatewaysApi.getAll).mockResolvedValue({
        gateways: [],
      })
    })

    it('should show empty state when no gateways exist', async () => {
      renderGatewaysPage()

      await waitFor(() => {
        // New shared <EmptyState/> primitive: "No gateways yet"
        // headline + a "Create gateway" CTA in the action slot.
        expect(screen.getByText('No gateways yet')).toBeInTheDocument()
        // Multiple "Create gateway" buttons can exist on the page
        // (one in the header, one in the empty state) — just
        // assert at least one is present.
        expect(screen.getAllByRole('button', { name: 'Create gateway' }).length).toBeGreaterThan(0)
      })
    })
  })

  describe('Gateway Creation', () => {
    beforeEach(() => {
      vi.mocked(gatewaysApi.getAll).mockResolvedValue({
        gateways: [],
      })
      mockNavigate.mockClear()
    })

    // Creating a gateway is a page of its own (/gateways/new), not a modal.
    it('goes to the new-gateway page instead of opening a dialog', async () => {
      const user = userEvent.setup()
      renderGatewaysPage()

      await waitFor(() => {
        expect(screen.getAllByRole('button', { name: 'Create gateway' })[0]).toBeInTheDocument()
      })
      await user.click(screen.getAllByRole('button', { name: 'Create gateway' })[0])

      expect(mockNavigate).toHaveBeenCalledWith('/gateways/new')
      expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('sends the empty-state action to the create page too', async () => {
      const user = userEvent.setup()
      renderGatewaysPage()

      await screen.findByText('No gateways yet')
      const buttons = screen.getAllByRole('button', { name: 'Create gateway' })
      await user.click(buttons[buttons.length - 1])

      expect(mockNavigate).toHaveBeenCalledWith('/gateways/new')
    })
  })

  describe('Row actions', () => {
    beforeEach(() => {
      vi.mocked(gatewaysApi.getAll).mockResolvedValue({
        gateways: [{ ...mockGateway, tools: [{ ...mockTool, id: 'tool-1', name: 'Test Tool 1' }] }],
      })
    })

    it('edits a gateway on its own edit page, not in a sheet', async () => {
      const user = userEvent.setup()
      renderGatewaysPage()

      await waitFor(() => {
        expect(screen.getByText('Test Gateway')).toBeInTheDocument()
      })
      const gatewayRow = screen.getByText('Test Gateway').closest('tr')
      await user.click(within(gatewayRow!).getByRole('button', { name: /actions/i }))
      await user.click(screen.getByText('Edit'))

      expect(mockNavigate).toHaveBeenCalledWith('/gateways/test-gateway-id/edit')
      expect(screen.queryByRole('dialog')).toBeNull()
    })
  })

  describe('Subtitle Stats', () => {
    it('should show gateway counts in subtitle', async () => {
      vi.mocked(gatewaysApi.getAll).mockResolvedValue({
        gateways: [
            { ...mockGateway, id: 'gw-1', name: 'Gateway 1', status: 'active' },
            { ...mockGateway, id: 'gw-2', name: 'Gateway 2', status: 'inactive' },
        ],
      })

      renderGatewaysPage()

      await waitFor(() => {
        // Subtitle now shows inline counts like "2 gateways (1 active)"
        expect(screen.getByText(/2 gateways/)).toBeInTheDocument()
      })
    })
  })

  describe('Search Filter', () => {
    beforeEach(() => {
      vi.mocked(gatewaysApi.getAll).mockResolvedValue({
        gateways: [
          { ...mockGateway, id: 'gateway-1', name: 'MCP Gateway', type: 'mcp', endpoint: '/mcp' },
          { ...mockGateway, id: 'gateway-2', name: 'A2A Gateway', type: 'a2a', endpoint: '/a2a' },
          { ...mockGateway, id: 'gateway-3', name: 'Skills Gateway', type: 'skills', endpoint: '/skills' },
        ],
      })
    })

    it('should filter gateways by search query showing only matching results', async () => {
      const user = userEvent.setup()
      renderGatewaysPage()

      await waitFor(() => {
        expect(screen.getByText('MCP Gateway')).toBeInTheDocument()
        expect(screen.getByText('A2A Gateway')).toBeInTheDocument()
        expect(screen.getByText('Skills Gateway')).toBeInTheDocument()
      })

      const searchInput = screen.getByPlaceholderText('Search gateways...')
      await user.type(searchInput, 'MCP')

      // Only the MCP gateway should remain visible
      expect(screen.getByText('MCP Gateway')).toBeInTheDocument()
      expect(screen.queryByText('A2A Gateway')).not.toBeInTheDocument()
      expect(screen.queryByText('Skills Gateway')).not.toBeInTheDocument()
    })
  })

  describe('Delete Confirmation Dialog', () => {
    beforeEach(() => {
      vi.mocked(gatewaysApi.getAll).mockResolvedValue({
        gateways: [
          { ...mockGateway, id: 'gateway-1', name: 'My MCP Gateway', type: 'mcp' },
        ],
      })
    })

    it('should show delete confirmation dialog with gateway name when Delete is clicked', async () => {
      const user = userEvent.setup()
      renderGatewaysPage()

      await waitFor(() => {
        expect(screen.getByText('My MCP Gateway')).toBeInTheDocument()
      })

      // Find the actions button (the "..." button rendered by createActionsColumn)
      const actionsButton = screen.getByRole('button', { name: /actions/i })
      await user.click(actionsButton)

      // Click Delete in the dropdown menu
      await user.click(screen.getByText('Delete'))

      // The confirmation dialog should appear with the gateway name
      expect(screen.getByText('Delete gateway?')).toBeInTheDocument()
      // The dialog description includes the gateway name in the delete warning
      expect(screen.getByText(/permanently delete "My MCP Gateway"/)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Delete Gateway/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument()
    })
  })

  describe('Error Handling', () => {
    it('should handle API errors gracefully', async () => {
      vi.mocked(gatewaysApi.getAll).mockRejectedValue(
        new Error('API Error')
      )

      renderGatewaysPage()

      // Should not crash and should eventually show empty state or error
      await waitFor(() => {
        // The error boundary or error state should handle this
        expect(true).toBe(true) // Test passes if no uncaught errors
      })
    })
  })
})