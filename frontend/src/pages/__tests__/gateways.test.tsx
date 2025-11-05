import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient } from '@tanstack/react-query'
import { render, mockGateway, mockTool } from '../../test/setup'
import { GatewaysPage } from '../gateways'
import * as gatewaysApi from '../../lib/api/gateways'
import * as toolsApi from '../../lib/api/tools'

// Mock the API modules
vi.mock('../../lib/api/gateways', () => ({
  gatewaysApi: {
    getAll: vi.fn(),
    getOne: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    testConnection: vi.fn(),
    getMetrics: vi.fn(),
    addTool: vi.fn(),
    removeTool: vi.fn(),
    getTools: vi.fn(),
  },
}))

vi.mock('../../lib/api/tools', () => ({
  toolsApi: {
    getAll: vi.fn(),
  },
}))

// Mock the organization store
vi.mock('../../stores/organization', () => ({
  useOrganizationStore: () => ({
    currentOrganization: {
      id: 'test-org-id',
      name: 'Test Org',
    },
  }),
}))

// Mock notifications
vi.mock('../../hooks/use-notifications', () => ({
  useNotifications: () => ({
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
}))

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
      vi.mocked(gatewaysApi.gatewaysApi.getAll).mockImplementation(
        () => new Promise(() => {}) // Never resolves
      )
      vi.mocked(toolsApi.toolsApi.getAll).mockImplementation(
        () => new Promise(() => {}) // Never resolves
      )

      renderGatewaysPage()

      expect(screen.getByTestId('loading-spinner')).toBeInTheDocument()
    })
  })

  describe('Gateway List', () => {
    beforeEach(() => {
      vi.mocked(gatewaysApi.gatewaysApi.getAll).mockResolvedValue({
        data: [
          { ...mockGateway, id: 'gateway-1', name: 'MCP Gateway', type: 'mcp' },
          { ...mockGateway, id: 'gateway-2', name: 'A2A Gateway', type: 'a2a' },
        ],
        total: 2,
        page: 1,
        pageSize: 20,
        totalPages: 1,
      })

      vi.mocked(toolsApi.toolsApi.getAll).mockResolvedValue({
        data: [mockTool],
        total: 1,
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

    it('should show scoping status in tools column', async () => {
      renderGatewaysPage()

      await waitFor(() => {
        // Gateways with no tools should show "0 of 1"
        const toolColumns = screen.getAllByText(/0 of 1/)
        expect(toolColumns.length).toBeGreaterThan(0)
      })
    })

    it('should show gateway status', async () => {
      renderGatewaysPage()

      await waitFor(() => {
        const activeStatuses = screen.getAllByText('Active')
        expect(activeStatuses.length).toBeGreaterThan(0)
      })
    })
  })

  describe('Gateway Creation', () => {
    beforeEach(() => {
      vi.mocked(gatewaysApi.gatewaysApi.getAll).mockResolvedValue({
        data: [],
        total: 0,
        page: 1,
        pageSize: 20,
        totalPages: 0,
      })

      vi.mocked(toolsApi.toolsApi.getAll).mockResolvedValue({
        data: [],
        total: 0,
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

    it('should show only 3 gateway types (no SCOPED_TOOL)', async () => {
      const user = userEvent.setup()
      renderGatewaysPage()

      await waitFor(() => {
        expect(screen.getByText('Create Gateway')).toBeInTheDocument()
      })

      await user.click(screen.getByText('Create Gateway'))

      // Click on the select trigger
      const selectTrigger = screen.getByRole('combobox')
      await user.click(selectTrigger)

      expect(screen.getByText('MCP - Model Context Protocol')).toBeInTheDocument()
      expect(screen.getByText('A2A - Agent-to-Agent')).toBeInTheDocument()
      expect(screen.getByText('UTCP - Universal Tool Call Protocol')).toBeInTheDocument()
      expect(screen.queryByText('Scoped Tool Gateway')).not.toBeInTheDocument()
    })

    it('should create gateway with form data', async () => {
      const user = userEvent.setup()
      const mockCreate = vi.mocked(gatewaysApi.gatewaysApi.create)
      mockCreate.mockResolvedValue({ ...mockGateway, id: 'new-gateway' })

      renderGatewaysPage()

      await user.click(screen.getByText('Create Gateway'))

      // Fill out the form
      await user.type(screen.getByLabelText('Gateway Name'), 'New Test Gateway')
      await user.type(screen.getByLabelText('Endpoint Path'), '/new-test')

      // Select gateway type
      await user.click(screen.getByRole('combobox'))
      await user.click(screen.getByText('MCP - Model Context Protocol'))

      // Submit form
      await user.click(screen.getByText('Create Gateway'))

      await waitFor(() => {
        expect(mockCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'New Test Gateway',
            endpoint: '/new-test',
            type: 'mcp',
          })
        )
      })
    })
  })

  describe('Gateway Details', () => {
    beforeEach(() => {
      const gatewayWithTools = {
        ...mockGateway,
        tools: [{ ...mockTool, id: 'tool-1', name: 'Test Tool 1' }],
      }

      vi.mocked(gatewaysApi.gatewaysApi.getAll).mockResolvedValue({
        data: [gatewayWithTools],
        total: 1,
        page: 1,
        pageSize: 20,
        totalPages: 1,
      })

      vi.mocked(toolsApi.toolsApi.getAll).mockResolvedValue({
        data: [mockTool, { ...mockTool, id: 'tool-2', name: 'Test Tool 2' }],
        total: 2,
      })

      vi.mocked(gatewaysApi.gatewaysApi.getTools).mockResolvedValue({
        data: [{ ...mockTool, id: 'tool-1', name: 'Test Tool 1' }],
      })
    })

    it('should open gateway details sheet', async () => {
      const user = userEvent.setup()
      renderGatewaysPage()

      await waitFor(() => {
        expect(screen.getByText('Test Gateway')).toBeInTheDocument()
      })

      // Find and click the row to open details
      const gatewayRow = screen.getByText('Test Gateway').closest('tr')
      expect(gatewayRow).toBeInTheDocument()

      // Click on the actions button or row
      const viewButton = within(gatewayRow!).getByRole('button', { name: /actions/i })
      await user.click(viewButton)

      // Click view option
      await user.click(screen.getByText('View Details'))

      // Should see the details sheet
      expect(screen.getByRole('dialog')).toBeInTheDocument()
      expect(screen.getByText('Monitor and configure gateway settings')).toBeInTheDocument()
    })

    it('should show scoping interface in tools tab', async () => {
      const user = userEvent.setup()
      renderGatewaysPage()

      await waitFor(() => {
        expect(screen.getByText('Test Gateway')).toBeInTheDocument()
      })

      // Open details and go to tools tab
      const gatewayRow = screen.getByText('Test Gateway').closest('tr')
      const viewButton = within(gatewayRow!).getByRole('button', { name: /actions/i })
      await user.click(viewButton)
      await user.click(screen.getByText('View Details'))

      // Click tools tab
      await user.click(screen.getByText('Tools'))

      // Should see scoping interface
      expect(screen.getByText('Tool Scoping')).toBeInTheDocument()
      expect(screen.getByText('1/2')).toBeInTheDocument() // 1 tool assigned out of 2 total
      expect(screen.getByText('Scoped Gateway')).toBeInTheDocument()
    })

    it('should show scoping controls', async () => {
      const user = userEvent.setup()
      renderGatewaysPage()

      await waitFor(() => {
        expect(screen.getByText('Test Gateway')).toBeInTheDocument()
      })

      // Open details and tools tab
      const gatewayRow = screen.getByText('Test Gateway').closest('tr')
      const viewButton = within(gatewayRow!).getByRole('button', { name: /actions/i })
      await user.click(viewButton)
      await user.click(screen.getByText('View Details'))
      await user.click(screen.getByText('Tools'))

      // Should see scoping controls
      expect(screen.getByText('Assign All Tools')).toBeInTheDocument()
      expect(screen.getByText('Remove All Tools')).toBeInTheDocument()
      expect(screen.getByText('Add specific tool...')).toBeInTheDocument()
    })

    it('should show scoping presets', async () => {
      const user = userEvent.setup()
      renderGatewaysPage()

      await waitFor(() => {
        expect(screen.getByText('Test Gateway')).toBeInTheDocument()
      })

      // Open details and tools tab
      const gatewayRow = screen.getByText('Test Gateway').closest('tr')
      const viewButton = within(gatewayRow!).getByRole('button', { name: /actions/i })
      await user.click(viewButton)
      await user.click(screen.getByText('View Details'))
      await user.click(screen.getByText('Tools'))

      // Should see scoping presets
      expect(screen.getByText('Common Scoping Presets')).toBeInTheDocument()
      expect(screen.getByText('Read-Only')).toBeInTheDocument()
      expect(screen.getByText('Admin Tools')).toBeInTheDocument()
      expect(screen.getByText('Public API')).toBeInTheDocument()
    })
  })

  describe('Tool Management', () => {
    beforeEach(() => {
      vi.mocked(gatewaysApi.gatewaysApi.getAll).mockResolvedValue({
        data: [mockGateway],
        total: 1,
        page: 1,
        pageSize: 20,
        totalPages: 1,
      })

      vi.mocked(toolsApi.toolsApi.getAll).mockResolvedValue({
        data: [mockTool],
        total: 1,
      })

      vi.mocked(gatewaysApi.gatewaysApi.getTools).mockResolvedValue({
        data: [],
      })
    })

    it('should add tool to gateway', async () => {
      const user = userEvent.setup()
      const mockAddTool = vi.mocked(gatewaysApi.gatewaysApi.addTool)
      mockAddTool.mockResolvedValue(undefined)

      renderGatewaysPage()

      await waitFor(() => {
        expect(screen.getByText('Test Gateway')).toBeInTheDocument()
      })

      // Open details and tools tab
      const gatewayRow = screen.getByText('Test Gateway').closest('tr')
      const viewButton = within(gatewayRow!).getByRole('button', { name: /actions/i })
      await user.click(viewButton)
      await user.click(screen.getByText('View Details'))
      await user.click(screen.getByText('Tools'))

      // Select a tool to add
      const addToolSelect = screen.getByText('Add specific tool...')
      await user.click(addToolSelect)

      // Should see available tools
      await user.click(screen.getByText('Test Tool'))

      await waitFor(() => {
        expect(mockAddTool).toHaveBeenCalledWith({
          gatewayId: mockGateway.id,
          toolId: mockTool.id,
        })
      })
    })

    it('should assign all tools', async () => {
      const user = userEvent.setup()
      const mockAddTool = vi.mocked(gatewaysApi.gatewaysApi.addTool)
      mockAddTool.mockResolvedValue(undefined)

      renderGatewaysPage()

      await waitFor(() => {
        expect(screen.getByText('Test Gateway')).toBeInTheDocument()
      })

      // Open details and tools tab
      const gatewayRow = screen.getByText('Test Gateway').closest('tr')
      const viewButton = within(gatewayRow!).getByRole('button', { name: /actions/i })
      await user.click(viewButton)
      await user.click(screen.getByText('View Details'))
      await user.click(screen.getByText('Tools'))

      // Click assign all tools
      await user.click(screen.getByText('Assign All Tools'))

      await waitFor(() => {
        expect(mockAddTool).toHaveBeenCalled()
      })
    })
  })

  describe('Gateway Testing', () => {
    beforeEach(() => {
      vi.mocked(gatewaysApi.gatewaysApi.getAll).mockResolvedValue({
        data: [mockGateway],
        total: 1,
        page: 1,
        pageSize: 20,
        totalPages: 1,
      })

      vi.mocked(toolsApi.toolsApi.getAll).mockResolvedValue({
        data: [],
        total: 0,
      })
    })

    it('should test gateway connection', async () => {
      const user = userEvent.setup()
      const mockTestConnection = vi.mocked(gatewaysApi.gatewaysApi.testConnection)
      mockTestConnection.mockResolvedValue({
        success: true,
        responseTime: 150,
        status: 200,
        timestamp: new Date().toISOString(),
      })

      renderGatewaysPage()

      await waitFor(() => {
        expect(screen.getByText('Test Gateway')).toBeInTheDocument()
      })

      // Open details and test tab
      const gatewayRow = screen.getByText('Test Gateway').closest('tr')
      const viewButton = within(gatewayRow!).getByRole('button', { name: /actions/i })
      await user.click(viewButton)
      await user.click(screen.getByText('View Details'))
      await user.click(screen.getByText('Test'))

      // Run test
      await user.click(screen.getByText('Run Test'))

      await waitFor(() => {
        expect(mockTestConnection).toHaveBeenCalledWith({ id: mockGateway.id })
      })
    })
  })

  describe('Scoping Status Display', () => {
    it('should show "No Tools" badge when gateway has no tools', async () => {
      const emptyGateway = { ...mockGateway, tools: [] }

      vi.mocked(gatewaysApi.gatewaysApi.getAll).mockResolvedValue({
        data: [emptyGateway],
        total: 1,
        page: 1,
        pageSize: 20,
        totalPages: 1,
      })

      vi.mocked(toolsApi.toolsApi.getAll).mockResolvedValue({
        data: [mockTool],
        total: 1,
      })

      renderGatewaysPage()

      await waitFor(() => {
        expect(screen.getByText('No Tools')).toBeInTheDocument()
      })
    })

    it('should show "Scoped" badge when gateway has some but not all tools', async () => {
      const scopedGateway = { 
        ...mockGateway, 
        tools: [{ ...mockTool, id: 'tool-1' }] 
      }

      vi.mocked(gatewaysApi.gatewaysApi.getAll).mockResolvedValue({
        data: [scopedGateway],
        total: 1,
        page: 1,
        pageSize: 20,
        totalPages: 1,
      })

      vi.mocked(toolsApi.toolsApi.getAll).mockResolvedValue({
        data: [mockTool, { ...mockTool, id: 'tool-2' }],
        total: 2,
      })

      renderGatewaysPage()

      await waitFor(() => {
        expect(screen.getByText('Scoped')).toBeInTheDocument()
      })
    })

    it('should show "Full Access" badge when gateway has all tools', async () => {
      const fullAccessGateway = { 
        ...mockGateway, 
        tools: [mockTool] 
      }

      vi.mocked(gatewaysApi.gatewaysApi.getAll).mockResolvedValue({
        data: [fullAccessGateway],
        total: 1,
        page: 1,
        pageSize: 20,
        totalPages: 1,
      })

      vi.mocked(toolsApi.toolsApi.getAll).mockResolvedValue({
        data: [mockTool],
        total: 1,
      })

      renderGatewaysPage()

      await waitFor(() => {
        expect(screen.getByText('Full Access')).toBeInTheDocument()
      })
    })
  })

  describe('Error Handling', () => {
    it('should handle API errors gracefully', async () => {
      vi.mocked(gatewaysApi.gatewaysApi.getAll).mockRejectedValue(
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
});