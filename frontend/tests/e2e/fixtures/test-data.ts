/**
 * Test Data Fixtures
 * Real API endpoints and data for E2E testing
 */

export const TEST_APIS = {
  /**
   * Petstore API - OpenAPI 2.0
   * Official Swagger Petstore with 20 operations
   */
  PETSTORE: {
    name: 'Petstore API',
    baseUrl: 'https://petstore.swagger.io/v2',
    type: 'openapi' as const,
    description: 'Official Swagger Petstore API for testing',
    schemaUrl: 'https://petstore.swagger.io/v2/swagger.json',
    authentication: {
      type: 'none' as const,
      config: {},
    },
    expectedOperations: 20,
    expectedTools: 19, // As mentioned in CLAUDE.md
  },

  /**
   * JSONPlaceholder - REST API
   * Fake online REST API for testing
   */
  JSONPLACEHOLDER: {
    name: 'JSONPlaceholder API',
    baseUrl: 'https://jsonplaceholder.typicode.com',
    type: 'openapi' as const,
    description: 'Free fake REST API for testing and prototyping',
    schemaUrl: 'https://jsonplaceholder.typicode.com/schema',
    authentication: {
      type: 'none' as const,
      config: {},
    },
  },

  /**
   * GitHub API - OpenAPI 3.0
   * Well-documented public API
   */
  GITHUB: {
    name: 'GitHub API',
    baseUrl: 'https://api.github.com',
    type: 'openapi' as const,
    description: 'GitHub REST API v3',
    schemaUrl: 'https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json',
    authentication: {
      type: 'bearer' as const,
      config: {
        token: process.env.GITHUB_TOKEN || 'test-token',
      },
    },
  },

  /**
   * SWAPI - Star Wars API
   * Simple, no-auth REST API
   */
  SWAPI: {
    name: 'Star Wars API',
    baseUrl: 'https://swapi.dev/api',
    type: 'openapi' as const,
    description: 'The Star Wars API - All Star Wars data you need',
    authentication: {
      type: 'none' as const,
      config: {},
    },
  },

  /**
   * Rick and Morty API - GraphQL
   * Public GraphQL API for testing
   */
  RICKANDMORTY_GRAPHQL: {
    name: 'Rick and Morty GraphQL API',
    baseUrl: 'https://rickandmortyapi.com/graphql',
    type: 'graphql' as const,
    description: 'The Rick and Morty API GraphQL endpoint',
    authentication: {
      type: 'none' as const,
      config: {},
    },
  },
}

// Generate unique endpoints per test run to avoid conflicts
const generateUniqueEndpoint = (base: string) => {
  const timestamp = Date.now()
  const random = Math.random().toString(36).substring(7)
  return `/${base}-${timestamp}-${random}`
}

export const TEST_GATEWAY_CONFIGS = {
  /**
   * MCP Gateway for public APIs
   */
  PUBLIC_MCP: {
    name: 'Public MCP Gateway',
    type: 'mcp' as const,
    endpointPath: generateUniqueEndpoint('public-mcp'),
    description: 'Gateway for public read-only operations',
  },

  /**
   * A2A Gateway for admin operations
   */
  ADMIN_A2A: {
    name: 'Admin A2A Gateway',
    type: 'a2a' as const,
    endpointPath: generateUniqueEndpoint('admin-a2a'),
    description: 'Gateway for admin operations with full access',
  },

  /**
   * UTCP Gateway for testing
   */
  TEST_UTCP: {
    name: 'Test UTCP Gateway',
    type: 'utcp' as const,
    endpointPath: generateUniqueEndpoint('test-utcp'),
    description: 'Gateway for testing tool execution',
  },
}

export const TEST_SCOPING_SCENARIOS = {
  /**
   * Read-only scoping: Only GET operations
   */
  READ_ONLY: {
    name: 'Read-Only Access',
    description: 'Assign only GET/read operations',
    filterMethod: (tool: any) => tool.method === 'GET',
  },

  /**
   * Admin scoping: All operations
   */
  FULL_ADMIN: {
    name: 'Full Admin Access',
    description: 'Assign all tools without restrictions',
    filterMethod: () => true,
  },

  /**
   * Public API scoping: Safe operations only
   */
  PUBLIC_API: {
    name: 'Public API Access',
    description: 'Assign only safe, public operations',
    filterMethod: (tool: any) => ['GET', 'HEAD', 'OPTIONS'].includes(tool.method),
  },

  /**
   * Specific tools: Manual selection
   */
  SPECIFIC_TOOLS: {
    name: 'Specific Tools',
    description: 'Manually selected specific tools',
    toolIds: [] as string[], // Populated during test
  },
}

export const TEST_ORGANIZATIONS = {
  DEFAULT: {
    name: 'Test Organization',
    description: 'Default test organization for E2E tests',
  },
  TEAM_ORG: {
    name: 'Team Test Org',
    description: 'Organization for testing team features',
  },
}

export const TEST_USERS = {
  ADMIN: {
    email: 'admin@test.com',
    password: 'Admin@123456',
    firstName: 'Admin',
    lastName: 'User',
    role: 'admin' as const,
  },
  MEMBER: {
    email: 'member@test.com',
    password: 'Member@123456',
    firstName: 'Member',
    lastName: 'User',
    role: 'member' as const,
  },
  VIEWER: {
    email: 'viewer@test.com',
    password: 'Viewer@123456',
    firstName: 'Viewer',
    lastName: 'User',
    role: 'viewer' as const,
  },
}

/**
 * Test tool configurations
 */
export const TEST_TOOLS = {
  REST_GET: {
    name: 'Test GET Tool',
    method: 'GET',
    endpoint: '/users/1',
    description: 'Test tool for GET requests',
  },
  REST_POST: {
    name: 'Test POST Tool',
    method: 'POST',
    endpoint: '/users',
    description: 'Test tool for POST requests',
  },
  REST_PUT: {
    name: 'Test PUT Tool',
    method: 'PUT',
    endpoint: '/users/1',
    description: 'Test tool for PUT requests',
  },
  REST_DELETE: {
    name: 'Test DELETE Tool',
    method: 'DELETE',
    endpoint: '/users/1',
    description: 'Test tool for DELETE requests',
  },
}
