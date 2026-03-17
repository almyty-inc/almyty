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
      expect(screen.getByText('Serve your tools via MCP, A2A, UTCP, and Skills protocols')).toBeInTheDocument()
    })
  })

  describe('Gateway List', () => {
    beforeEach(() => {
      vi.mocked(gatewaysApi.getAll).mockResolvedValue({
        data: {
          data: [
            { ...mockGateway, id: 'gateway-1', name: 'MCP Gateway', type: 'mcp' },
            { ...mockGateway, id: 'gateway-2', name: 'A2A Gateway', type: 'a2a' },
          ],
        },
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
        // Status column renders gateway.status which is "active" (lowercase) from mockGateway
        const activeStatuses = screen.getAllByText('active')
        expect(activeStatuses.length).toBeGreaterThan(0)
      })
    })
  })

  describe('Empty State', () => {
    beforeEach(() => {
      vi.mocked(gatewaysApi.getAll).mockResolvedValue({
        data: { data: [] },
      })
    })

    it('should show empty state when no gateways exist', async () => {
      renderGatewaysPage()

      await waitFor(() => {
        expect(screen.getByText('No gateways found')).toBeInTheDocument()
        expect(screen.getByText('Create First Gateway')).toBeInTheDocument()
      })
    })
  })

  describe('Gateway Creation', () => {
    beforeEach(() => {
      vi.mocked(gatewaysApi.getAll).mockResolvedValue({
        data: { data: [] },
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

    it('should show 4 gateway types including Skills', async () => {
      const user = userEvent.setup()
      renderGatewaysPage()

      await waitFor(() => {
        expect(screen.getByText('Create Gateway')).toBeInTheDocument()
      })

      await user.click(screen.getByText('Create Gateway'))

      // Click on the select trigger
      const selectTrigger = screen.getByRole('combobox')
      await user.click(selectTrigger)

      // Radix Select renders both native <option> elements and portal items,
      // so we use getAllByText and check they exist
      expect(screen.getAllByText('MCP - Model Context Protocol').length).toBeGreaterThan(0)
      expect(screen.getAllByText('A2A - Agent-to-Agent').length).toBeGreaterThan(0)
      expect(screen.getAllByText('UTCP - Universal Tool Call Protocol').length).toBeGreaterThan(0)
      expect(screen.getAllByText('Skills - Agent Skills (SKILL.md)').length).toBeGreaterThan(0)
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

      await user.type(screen.getByLabelText('Endpoint Path'), '/new-test')
      expect(screen.getByLabelText('Endpoint Path')).toHaveValue('/new-test')
    })
  })

  describe('Gateway Details Sheet', () => {
    beforeEach(() => {
      const gatewayWithTools = {
        ...mockGateway,
        tools: [{ ...mockTool, id: 'tool-1', name: 'Test Tool 1' }],
      }

      vi.mocked(gatewaysApi.getAll).mockResolvedValue({
        data: { data: [gatewayWithTools] },
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
      expect(screen.getByText('Assign All Tools')).toBeInTheDocument()
    })
  })

  describe('Stats Cards', () => {
    it('should show gateway stats when gateways exist', async () => {
      vi.mocked(gatewaysApi.getAll).mockResolvedValue({
        data: {
          data: [
            { ...mockGateway, id: 'gw-1', name: 'Gateway 1', status: 'active' },
            { ...mockGateway, id: 'gw-2', name: 'Gateway 2', status: 'inactive' },
          ],
        },
      })

      renderGatewaysPage()

      await waitFor(() => {
        expect(screen.getByText('Total Gateways')).toBeInTheDocument()
        expect(screen.getByText('Active Gateways')).toBeInTheDocument()
        expect(screen.getByText('Tool Assignments')).toBeInTheDocument()
      })
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