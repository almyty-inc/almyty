import '@testing-library/jest-dom'
import { vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeAll, afterAll } from 'vitest'

// Cleanup after each test
afterEach(() => {
  cleanup()
})

// Mock IntersectionObserver / ResizeObserver.
//
// vitest 4 made `vi.fn().mockImplementation(arrow)` non-constructable,
// which Radix + @floating-ui now invoke via `new ResizeObserver(...)`
// inside `autoUpdate()`. Use real class stubs so `new` works.
class MockIntersectionObserver {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
  takeRecords = vi.fn().mockReturnValue([])
  root = null
  rootMargin = ''
  thresholds = []
}
class MockResizeObserver {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
}
global.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver
global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver

// Mock matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(), // deprecated
    removeListener: vi.fn(), // deprecated
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

// Mock scrollTo
Object.defineProperty(window, 'scrollTo', {
  writable: true,
  value: vi.fn(),
})

// Mock HTMLElement.scrollIntoView
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
  writable: true,
  value: vi.fn(),
})

// Mock Recharts ResponsiveContainer
vi.mock('recharts', async () => {
  const actual = await vi.importActual('recharts')
  const React = await import('react')
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) =>
      React.createElement('div', { style: { width: 400, height: 300 } }, children),
  }
})

// Mock axios
vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => ({
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      patch: vi.fn(),
      interceptors: {
        request: { use: vi.fn(), eject: vi.fn() },
        response: { use: vi.fn(), eject: vi.fn() },
      },
    })),
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    patch: vi.fn(),
  },
}))

// Mock react-router-dom
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useParams: () => ({}),
    useSearchParams: () => [new URLSearchParams(), vi.fn()],
    useLocation: () => ({
      pathname: '/',
      search: '',
      hash: '',
      state: null,
    }),
  }
})

// Silence console errors during tests
const originalError = console.error
beforeAll(() => {
  console.error = (...args) => {
    if (
      typeof args[0] === 'string' &&
      args[0].includes('Warning: ReactDOM.render is no longer supported')
    ) {
      return
    }
    originalError.call(console, ...args)
  }
})

afterAll(() => {
  console.error = originalError
})

// Global test utilities
export const mockUser = {
  id: 'test-user-id',
  email: 'test@example.com',
  name: 'Test User',
  role: 'admin',
  organizationId: 'test-org-id',
}

export const mockOrganization = {
  id: 'test-org-id',
  name: 'Test Organization',
  description: 'A test organization',
  plan: 'pro',
  isActive: true,
}

export const mockGateway = {
  id: 'test-gateway-id',
  name: 'Test Gateway',
  type: 'mcp',
  endpoint: '/test-gateway',
  status: 'active',
  isHealthy: true,
  totalRequests: 100,
  successfulRequests: 95,
  requestTimeout: 30000,
  maxRetries: 3,
  rateLimitConfig: { enabled: false },
  corsConfig: { enabled: false },
  authConfig: { required: false },
  tools: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

export const mockTool = {
  id: 'test-tool-id',
  name: 'Test Tool',
  type: 'REST_API',
  category: 'api',
  description: 'A test tool',
  endpoint: 'https://api.example.com/test',
  method: 'GET',
  isActive: true,
  parameters: {},
  authConfig: { type: 'none' },
  rateLimitConfig: { enabled: false },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

export const mockApi = {
  id: 'test-api-id',
  name: 'Test API',
  type: 'openapi',
  baseUrl: 'https://api.example.com',
  description: 'A test API',
  isActive: true,
  schema: {},
  authConfig: { type: 'none' },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

// Test wrapper with providers
import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import { render, RenderOptions } from '@testing-library/react'

interface CustomRenderOptions extends Omit<RenderOptions, 'wrapper'> {
  queryClient?: QueryClient
}

const createWrapper = (queryClient?: QueryClient) => {
  const testQueryClient = queryClient || new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
      mutations: {
        retry: false,
      },
    },
  })

  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={testQueryClient}>
      <BrowserRouter>
        {children}
      </BrowserRouter>
    </QueryClientProvider>
  )
}

export const renderWithProviders = (
  ui: React.ReactElement,
  options: CustomRenderOptions = {}
) => {
  const { queryClient, ...renderOptions } = options
  const Wrapper = createWrapper(queryClient)
  return render(ui, { wrapper: Wrapper, ...renderOptions })
}

// Re-export everything from testing-library
export * from '@testing-library/react'
export { renderWithProviders as render }