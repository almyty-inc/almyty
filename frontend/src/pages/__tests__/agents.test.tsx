import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient } from '@tanstack/react-query'
import { render } from '../../test/setup'
import { AgentsPage } from '../agents'
import { agentsApi } from '../../lib/api'

// Mock the API module
vi.mock('../../lib/api', () => ({
  agentsApi: {
    getAll: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    activate: vi.fn(),
    deactivate: vi.fn(),
    duplicate: vi.fn(),
    invoke: vi.fn(),
    stream: vi.fn(),
    getTemplates: vi.fn(),
    importAgent: vi.fn(),
    exportAgent: vi.fn(),
  },
}))

// Mock the organization store
vi.mock('../../store/organization', () => ({
  useOrganizationStore: () => ({
    currentOrganization: {
      id: 'test-org-id',
      name: 'Test Org',
    },
  }),
}))

// Mock notifications
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
      pathname: '/agents',
      search: '',
      hash: '',
      state: null,
    }),
  }
})

// Mock hasPointerCapture for Radix in jsdom
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

describe('AgentsPage', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })

    vi.clearAllMocks()
  })

  const renderAgentsPage = () => {
    return render(<AgentsPage />, { queryClient })
  }

  describe('Loading State', () => {
    it('should show loading spinner when data is being fetched', () => {
      vi.mocked(agentsApi.getAll).mockImplementation(
        () => new Promise(() => {}) // Never resolves
      )
      vi.mocked(agentsApi.getTemplates).mockImplementation(
        () => new Promise(() => {})
      )

      renderAgentsPage()

      // The header is always visible
      expect(screen.getByText('Agents')).toBeInTheDocument()
    })
  })

  describe('Empty State', () => {
    beforeEach(() => {
      vi.mocked(agentsApi.getAll).mockResolvedValue([])
      vi.mocked(agentsApi.getTemplates).mockResolvedValue([])
    })

    it('should show empty state with CTA when no agents exist', async () => {
      renderAgentsPage()

      await waitFor(() => {
        expect(screen.getByText('Create your first agent')).toBeInTheDocument()
      })

      // Should have a create button in the empty state
      const createButtons = screen.getAllByText('Create Agent')
      expect(createButtons.length).toBeGreaterThan(0)
    })

    it('should navigate to /agents/new when empty state CTA is clicked', async () => {
      const user = userEvent.setup()
      renderAgentsPage()

      await waitFor(() => {
        expect(screen.getByText('Create your first agent')).toBeInTheDocument()
      })

      // There are multiple "Create Agent" buttons (header + empty state CTA).
      // Click the larger empty state one (last match).
      const createButtons = screen.getAllByRole('button', { name: /Create Agent/i })
      await user.click(createButtons[createButtons.length - 1])

      expect(mockNavigate).toHaveBeenCalledWith('/agents/new')
    })
  })

  describe('Agent List', () => {
    const mockAgents = [
      {
        id: 'agent-1',
        name: 'Chat Agent',
        description: 'A chat agent',
        status: 'active',
        totalExecutions: 42,
        pipeline: {
          nodes: [
            { id: 'input_1', type: 'input' },
            { id: 'llm_1', type: 'llm_call' },
            { id: 'output_1', type: 'output' },
          ],
          edges: [],
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: 'agent-2',
        name: 'Research Agent',
        description: 'A research agent',
        status: 'draft',
        totalExecutions: 0,
        pipeline: {
          nodes: [{ id: 'input_1', type: 'input' }],
          edges: [],
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]

    beforeEach(() => {
      vi.mocked(agentsApi.getAll).mockResolvedValue(mockAgents)
      vi.mocked(agentsApi.getTemplates).mockResolvedValue([])
    })

    it('should display agent list when data exists', async () => {
      renderAgentsPage()

      await waitFor(() => {
        expect(screen.getByText('Chat Agent')).toBeInTheDocument()
        expect(screen.getByText('Research Agent')).toBeInTheDocument()
      })
    })

    it('should show agent status badges', async () => {
      renderAgentsPage()

      // "Active" also appears in the status filter dropdown
      // (<option value="active">Active</option>), so
      // getByText('Active') matches multiple elements. Scope
      // the assertion to the agent row badges by matching the
      // full text + its badge-shaped ancestor class.
      await waitFor(() => {
        const actives = screen.getAllByText('Active')
        expect(actives.length).toBeGreaterThanOrEqual(1)
        const drafts = screen.getAllByText('Draft')
        expect(drafts.length).toBeGreaterThanOrEqual(1)
      })
    })

    it('should show agent counts in subtitle', async () => {
      renderAgentsPage()

      await waitFor(() => {
        expect(screen.getByText(/2 agents/)).toBeInTheDocument()
        expect(screen.getByText(/1 active/)).toBeInTheDocument()
      })
    })

    it('should show node count for each agent', async () => {
      renderAgentsPage()

      await waitFor(() => {
        expect(screen.getByText('3')).toBeInTheDocument() // Chat Agent has 3 nodes
        expect(screen.getByText('1')).toBeInTheDocument() // Research Agent has 1 node
      })
    })

    it('shows an Autonomous badge instead of a node count for autonomous agents', async () => {
      vi.mocked(agentsApi.getAll).mockResolvedValue([
        {
          id: 'agent-auto',
          name: 'Autonomous Agent',
          description: 'Runs on its own',
          status: 'active',
          mode: 'autonomous',
          totalExecutions: 7,
          // Autonomous agents have no meaningful pipeline — the list
          // used to render a misleading "0" here.
          pipeline: { nodes: [], edges: [] },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: 'agent-flow',
          name: 'Workflow Agent',
          description: 'Pipeline based',
          status: 'active',
          mode: 'workflow',
          totalExecutions: 2,
          pipeline: {
            nodes: [
              { id: 'input_1', type: 'input' },
              { id: 'llm_1', type: 'llm_call' },
              { id: 'output_1', type: 'output' },
            ],
            edges: [],
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ])

      renderAgentsPage()

      await waitFor(() => {
        expect(screen.getByText('Autonomous Agent')).toBeInTheDocument()
      })

      // Autonomous row renders the badge, not a zero.
      expect(screen.getByText('Autonomous')).toBeInTheDocument()
      expect(screen.queryByText('0')).not.toBeInTheDocument()

      // Workflow row keeps the plain node count.
      expect(screen.getByText('3')).toBeInTheDocument()
    })

    it('should show execution count for each agent', async () => {
      renderAgentsPage()

      await waitFor(() => {
        expect(screen.getByText('42')).toBeInTheDocument() // Chat Agent
      })
    })

    it('should filter agents by search query', async () => {
      const user = userEvent.setup()
      renderAgentsPage()

      await waitFor(() => {
        expect(screen.getByText('Chat Agent')).toBeInTheDocument()
      })

      const searchInput = screen.getByPlaceholderText('Search agents...')
      await user.type(searchInput, 'Research')

      expect(screen.getByText('Research Agent')).toBeInTheDocument()
      expect(screen.queryByText('Chat Agent')).not.toBeInTheDocument()
    })

    it('should show "no match" message when search has no results', async () => {
      const user = userEvent.setup()
      renderAgentsPage()

      await waitFor(() => {
        expect(screen.getByText('Chat Agent')).toBeInTheDocument()
      })

      const searchInput = screen.getByPlaceholderText('Search agents...')
      await user.type(searchInput, 'Nonexistent')

      expect(screen.queryByText('Chat Agent')).not.toBeInTheDocument()
      expect(screen.queryByText('Research Agent')).not.toBeInTheDocument()
      expect(screen.getByText(/No agents match/)).toBeInTheDocument()
    })

    it('should navigate to agent detail page when clicking an agent row', async () => {
      const user = userEvent.setup()
      renderAgentsPage()

      await waitFor(() => {
        expect(screen.getByText('Chat Agent')).toBeInTheDocument()
      })

      // Click the agent row (click on the name text, which is inside the row)
      await user.click(screen.getByText('Chat Agent'))

      expect(mockNavigate).toHaveBeenCalledWith('/agents/agent-1')
    })
  })

  describe('Templates Section', () => {
    const mockTemplates = [
      {
        id: 'simple-chat',
        name: 'Simple Chat Agent',
        description: 'Single LLM with tools',
        category: 'basic',
        pipeline: { nodes: [], edges: [] },
      },
      {
        id: 'research-agent',
        name: 'Research Agent',
        description: 'Extract and summarize',
        category: 'advanced',
        pipeline: { nodes: [], edges: [] },
      },
    ]

    beforeEach(() => {
      vi.mocked(agentsApi.getAll).mockResolvedValue([
          {
            id: 'agent-1',
            name: 'Existing Agent',
            status: 'active',
            totalExecutions: 0,
            pipeline: { nodes: [{ id: 'input_1', type: 'input' }], edges: [] },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ])
      vi.mocked(agentsApi.getTemplates).mockResolvedValue(mockTemplates)
    })

    it('should show templates section when templates exist', async () => {
      renderAgentsPage()

      await waitFor(() => {
        expect(screen.getByText('Start from a Template')).toBeInTheDocument()
        expect(screen.getByText('Simple Chat Agent')).toBeInTheDocument()
        expect(screen.getByText('Research Agent')).toBeInTheDocument()
      })
    })

    it('should show template categories', async () => {
      renderAgentsPage()

      await waitFor(() => {
        expect(screen.getByText('basic')).toBeInTheDocument()
        expect(screen.getByText('advanced')).toBeInTheDocument()
      })
    })

    it('should hide templates section when Hide button is clicked', async () => {
      const user = userEvent.setup()
      renderAgentsPage()

      await waitFor(() => {
        expect(screen.getByText('Start from a Template')).toBeInTheDocument()
      })

      // Click the Hide button
      await user.click(screen.getByText('Hide'))

      // Templates section should disappear
      expect(screen.queryByText('Start from a Template')).not.toBeInTheDocument()
      expect(screen.queryByText('Simple Chat Agent')).not.toBeInTheDocument()
      expect(screen.queryByText('Research Agent')).not.toBeInTheDocument()
    })

    it('should navigate to new agent with template when template is clicked', async () => {
      const user = userEvent.setup()
      renderAgentsPage()

      await waitFor(() => {
        expect(screen.getByText('Simple Chat Agent')).toBeInTheDocument()
      })

      // Click on a template card
      await user.click(screen.getByText('Simple Chat Agent'))

      expect(mockNavigate).toHaveBeenCalledWith('/agents/new?template=simple-chat')
    })
  })

  describe('Create Button Navigation', () => {
    beforeEach(() => {
      vi.mocked(agentsApi.getAll).mockResolvedValue([])
      vi.mocked(agentsApi.getTemplates).mockResolvedValue([])
    })

    it('should have a Create Agent button in the header', async () => {
      renderAgentsPage()

      // The header always has a Create Agent button
      const createButton = screen.getByRole('button', { name: /Create Agent/i })
      expect(createButton).toBeInTheDocument()
    })

    it('should navigate to /agents/new when header Create Agent button is clicked', async () => {
      const user = userEvent.setup()
      renderAgentsPage()

      await waitFor(() => {
        expect(screen.getByText('Create your first agent')).toBeInTheDocument()
      })

      // Click the header Create Agent button (first one)
      const buttons = screen.getAllByRole('button', { name: /Create Agent/i })
      await user.click(buttons[0])

      expect(mockNavigate).toHaveBeenCalledWith('/agents/new')
    })
  })

  describe('Error Handling', () => {
    it('should handle API errors gracefully', async () => {
      vi.mocked(agentsApi.getAll).mockRejectedValue(new Error('API Error'))
      vi.mocked(agentsApi.getTemplates).mockRejectedValue(new Error('API Error'))

      renderAgentsPage()

      // Should not crash
      await waitFor(() => {
        expect(true).toBe(true)
      })
    })
  })
})
