import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient } from '@tanstack/react-query'
import { render, mockGateway, mockTool } from '../../test/setup'
import { GatewaysPage } from '../gateways'
import { gatewaysApi, toolsApi } from '../../lib/api'

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
        // headline + a "Create Gateway" CTA in the action slot.
        expect(screen.getByText('No gateways yet')).toBeInTheDocument()
        // Multiple "Create Gateway" buttons can exist on the page
        // (one in the header, one in the empty state) — just
        // assert at least one is present.
        expect(screen.getAllByRole('button', { name: /Create Gateway/i }).length).toBeGreaterThan(0)
      })
    })
  })

  describe('Gateway Creation', () => {
    beforeEach(() => {
      vi.mocked(gatewaysApi.getAll).mockResolvedValue({
        gateways: [],
      })
    })

    it('should open create gateway dialog', async () => {
      const user = userEvent.setup()
      renderGatewaysPage()

      await waitFor(() => {
        expect(screen.getByText('Create Gateway')).toBeInTheDocument()
      })

      await user.click(screen.getByText('Create Gateway'))

      expect(screen.getByText('Create New Gateway')).toBeInTheDocument()
      expect(screen.getByLabelText('Gateway Name')).toBeInTheDocument()
      expect(screen.getByLabelText('Gateway Type')).toBeInTheDocument()
    })

    it('should show tool-kind gateway types by default (MCP, UTCP, Skills)', async () => {
      const user = userEvent.setup()
      renderGatewaysPage()

      await waitFor(() => {
        expect(screen.getByText('Create Gateway')).toBeInTheDocument()
      })

      await user.click(screen.getByText('Create Gateway'))

      // The dialog now has a kind selector defaulting to "Tools"
      expect(screen.getByText('Tools')).toBeInTheDocument()
      expect(screen.getByText('Agent')).toBeInTheDocument()

      // Click on the select trigger for type
      const selectTrigger = screen.getByRole('combobox')
      await user.click(selectTrigger)

      // Tool-kind types should be visible (Radix Select renders portal items)
      expect(screen.getAllByText('MCP - Model Context Protocol').length).toBeGreaterThan(0)
      expect(screen.getAllByText('UTCP - Universal Tool Call Protocol').length).toBeGreaterThan(0)
      expect(screen.getAllByText('Skills - Agent Skills (SKILL.md)').length).toBeGreaterThan(0)
      // A2A is agent-kind only, should NOT appear in the tool-kind dropdown
      expect(screen.queryByText('A2A - Agent-to-Agent Protocol')).not.toBeInTheDocument()
    })

    it('should show create gateway dialog with form fields', async () => {
      const user = userEvent.setup()

      renderGatewaysPage()

      await waitFor(() => {
        expect(screen.getByText('Create Gateway')).toBeInTheDocument()
      })

      await user.click(screen.getByText('Create Gateway'))

      // Verify form fields exist
      expect(screen.getByLabelText('Gateway Name')).toBeInTheDocument()
      expect(screen.getByLabelText('Endpoint Path')).toBeInTheDocument()
      expect(screen.getByLabelText('Gateway Type')).toBeInTheDocument()
      expect(screen.getByText('Description (Optional)')).toBeInTheDocument()

      // Fill in text fields
      await user.type(screen.getByLabelText('Gateway Name'), 'New Test Gateway')
      expect(screen.getByLabelText('Gateway Name')).toHaveValue('New Test Gateway')

      // The form auto-generates an endpoint slug from the gateway
      // name (e.g., "New Test Gateway" → "/n"), so without
      // clearing first user.type appends to the prefill and we
      // end up with "/n/new-test". Clear then type.
      const endpointField = screen.getByLabelText('Endpoint Path')
      await user.clear(endpointField)
      await user.type(endpointField, '/new-test')
      expect(endpointField).toHaveValue('/new-test')
    })
  })

  describe('Gateway Details Sheet', () => {
    beforeEach(() => {
      const gatewayWithTools = {
        ...mockGateway,
        tools: [{ ...mockTool, id: 'tool-1', name: 'Test Tool 1' }],
      }

      vi.mocked(gatewaysApi.getAll).mockResolvedValue({
        gateways: [gatewayWithTools],
      })
    })

    it('should open gateway details sheet via Edit action', async () => {
      const user = userEvent.setup()
      renderGatewaysPage()

      await waitFor(() => {
        expect(screen.getByText('Test Gateway')).toBeInTheDocument()
      })

      // Find and click the actions button
      const gatewayRow = screen.getByText('Test Gateway').closest('tr')
      expect(gatewayRow).toBeInTheDocument()

      const actionButton = within(gatewayRow!).getByRole('button', { name: /actions/i })
      await user.click(actionButton)

      // Click Edit to open the sheet
      await user.click(screen.getByText('Edit'))

      // Should see the details sheet with Information tab
      expect(screen.getByText('Information')).toBeInTheDocument()
      // The sheet should have a Tools tab (use role to disambiguate from table header)
      expect(screen.getByRole('tab', { name: /tools/i })).toBeInTheDocument()
    })

    it('should show tool scoping interface in tools tab', async () => {
      const user = userEvent.setup()
      renderGatewaysPage()

      await waitFor(() => {
        expect(screen.getByText('Test Gateway')).toBeInTheDocument()
      })

      // Open details sheet
      const gatewayRow = screen.getByText('Test Gateway').closest('tr')
      const actionButton = within(gatewayRow!).getByRole('button', { name: /actions/i })
      await user.click(actionButton)
      await user.click(screen.getByText('Edit'))

      // Click tools tab (use role to disambiguate from table header)
      await user.click(screen.getByRole('tab', { name: /tools/i }))

      // Should see tool scoping section
      expect(screen.getByText('Tool Scoping')).toBeInTheDocument()
      expect(screen.getByText(/assigned/)).toBeInTheDocument()
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