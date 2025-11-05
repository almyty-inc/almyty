# Testing Guide

This document outlines the comprehensive testing strategy for the LLM Tool Gateway system.

## 🎯 Testing Overview

Our testing suite covers:
- **Backend Unit Tests**: Entity logic, services, utilities
- **Backend Integration Tests**: API endpoints, database operations
- **Frontend Unit Tests**: Components, hooks, utilities
- **Frontend Component Tests**: UI interactions, state management
- **End-to-End Tests**: Complete user workflows
- **Protocol Tests**: Gateway protocol implementations (MCP, A2A, UTCP)

## 🛠️ Prerequisites

- Node.js >= 18.0.0
- npm >= 8.0.0

## 🚀 Quick Start

### 1. Setup
```bash
# Install all dependencies
npm run setup

# Install Playwright browsers for E2E testing
npm run playwright:install
```

### 2. Run All Tests
```bash
# Complete test suite
npm test

# Individual test suites
npm run test:backend    # Backend unit & integration tests
npm run test:frontend   # Frontend unit & component tests
npm run test:e2e        # End-to-end tests with Playwright
```

### 3. Development Testing
```bash
# Watch mode for active development
npm run test:watch      # Both backend and frontend in watch mode
npm run test:watch:backend
npm run test:watch:frontend

# E2E tests with UI
cd frontend && npm run test:e2e:ui
```

## 📊 Coverage Goals

Our coverage thresholds are set at **80%** across:
- **Lines**: 80%
- **Functions**: 80% 
- **Branches**: 80%
- **Statements**: 80%

Coverage reports are generated in:
- Backend: `backend/coverage/`
- Frontend: `frontend/coverage/`

## 🏗️ Backend Testing

### Tech Stack
- **Jest**: Test framework
- **@nestjs/testing**: NestJS testing utilities
- **Supertest**: HTTP assertion testing
- **TypeORM**: Database testing utilities

### Test Structure
```
backend/src/
├── entities/
│   └── *.spec.ts          # Entity unit tests
├── modules/
│   ├── */
│   │   ├── *.service.spec.ts    # Service unit tests
│   │   └── *.controller.spec.ts # Controller integration tests
└── test/
    └── setup.ts           # Global test configuration
```

### Key Test Areas

#### 1. Entity Tests (`*.entity.spec.ts`)
- Business logic methods
- Validation rules
- Relationships
- Computed properties

```typescript
// Example: gateway.entity.spec.ts
describe('Gateway Entity', () => {
  it('should calculate success rate correctly', () => {
    gateway.totalRequests = 100;
    gateway.successfulRequests = 95;
    expect(gateway.getSuccessRate()).toBe(95);
  });
});
```

#### 2. Service Tests (`*.service.spec.ts`) 
- Core business logic
- External API interactions
- Error handling
- Data transformations

#### 3. Controller Tests (`*.controller.spec.ts`)
- HTTP request/response handling
- Authentication/authorization
- Input validation
- Error responses

#### 4. Protocol Handler Tests
- MCP JSON-RPC 2.0 compliance
- A2A message handling
- UTCP structured responses
- WebSocket connections

### Running Backend Tests
```bash
cd backend

# Unit tests only
npm test

# With coverage
npm run test:cov

# Watch mode
npm run test:watch

# Specific test file
npm test -- gateway.entity.spec.ts
```

## 🎨 Frontend Testing

### Tech Stack
- **Vitest**: Fast test framework
- **React Testing Library**: Component testing
- **@testing-library/user-event**: User interaction testing
- **Playwright**: End-to-end testing

### Test Structure
```
frontend/src/
├── components/
│   └── **/__tests__/*.test.tsx
├── pages/
│   └── __tests__/*.test.tsx
├── hooks/
│   └── **/__tests__/*.test.tsx
└── test/
    └── setup.ts           # Global test configuration
```

### Key Test Areas

#### 1. Component Tests
- Rendering behavior
- User interactions
- Props handling
- State changes

```typescript
// Example: data-table.test.tsx
describe('DataTable', () => {
  it('should filter data based on search input', async () => {
    render(<DataTable data={mockData} searchKey="name" />);
    
    await user.type(screen.getByRole('textbox'), 'Item 1');
    
    expect(screen.getByText('Item 1')).toBeInTheDocument();
    expect(screen.queryByText('Item 2')).not.toBeInTheDocument();
  });
});
```

#### 2. Page Tests
- Complete page functionality
- Navigation behavior
- API integration
- Error handling

#### 3. Hook Tests
- Custom hook logic
- State management
- Side effects

### Running Frontend Tests
```bash
cd frontend

# Unit tests
npm test

# With coverage
npm run test:coverage

# Watch mode  
npm test -- --watch

# UI mode
npm run test:ui
```

## 🎭 End-to-End Testing

### Tech Stack
- **Playwright**: Cross-browser E2E testing
- **Test scenarios**: Complete user workflows

### Test Structure
```
frontend/tests/e2e/
├── gateway-management.spec.ts  # Gateway CRUD operations
├── complete-workflow.spec.ts   # End-to-end user workflows
└── auth.spec.ts               # Authentication flows
```

### Key E2E Scenarios

#### 1. Gateway Management
- Create gateways with different protocols
- Configure tool scoping
- Test gateway connections
- Monitor gateway health

#### 2. Complete User Workflow
- API → Tools → Gateway → Scoping → Testing
- Multiple gateway types with different scoping
- Error handling and edge cases

#### 3. Scoping Workflows
- No tools (blocked gateway)
- Scoped tools (selective access)  
- Full access (all tools)
- Scoping presets (read-only, admin, public)

### Running E2E Tests
```bash
cd frontend

# All E2E tests
npm run test:e2e

# With UI (interactive mode)
npm run test:e2e:ui

# Debug mode
npm run test:e2e:debug

# Specific browsers
npx playwright test --project=chromium
npx playwright test --project=firefox
npx playwright test --project=webkit
```

## 🔧 Test Configuration

### Jest Configuration (Backend)
```json
{
  "coverageThreshold": {
    "global": {
      "branches": 80,
      "functions": 80, 
      "lines": 80,
      "statements": 80
    }
  }
}
```

### Vitest Configuration (Frontend)
```typescript
export default defineConfig({
  test: {
    coverage: {
      thresholds: {
        global: {
          branches: 75,
          functions: 75,
          lines: 75,
          statements: 75
        }
      }
    }
  }
})
```

### Playwright Configuration
```typescript
export default defineConfig({
  projects: [
    { name: 'chromium' },
    { name: 'firefox' }, 
    { name: 'webkit' },
    { name: 'Mobile Chrome' },
    { name: 'Mobile Safari' }
  ]
})
```

## 🎯 Key Testing Features

### 1. Scoping Verification
Our tests specifically verify the core scoping functionality:

```typescript
it('should show scoping status in tools column', async () => {
  // Gateway with no tools should show "No Tools" 
  expect(screen.getByText('No Tools')).toBeInTheDocument();
  
  // Gateway with some tools should show "Scoped"
  expect(screen.getByText('Scoped')).toBeInTheDocument();
  
  // Gateway with all tools should show "Full Access"
  expect(screen.getByText('Full Access')).toBeInTheDocument();
});
```

### 2. Protocol Testing
Each gateway protocol is thoroughly tested:

```typescript
describe('MCP Protocol', () => {
  it('should handle tools/list request', async () => {
    const response = await service.processRequest(gateway, {
      jsonrpc: '2.0',
      method: 'tools/list'
    });
    
    expect(response.success).toBe(true);
    expect(response.data.result.tools).toBeDefined();
  });
});
```

### 3. Architecture Validation
Tests verify the corrected architecture:

```typescript
it('should show only 3 gateway types (no SCOPED_TOOL)', async () => {
  // Should show MCP, A2A, UTCP
  expect(screen.getByText('MCP - Model Context Protocol')).toBeVisible();
  expect(screen.getByText('A2A - Agent-to-Agent')).toBeVisible();
  expect(screen.getByText('UTCP - Universal Tool Call Protocol')).toBeVisible();
  
  // Should NOT show scoped as separate type
  expect(screen.queryByText('Scoped Tool Gateway')).not.toBeVisible();
});
```

## 🚨 Common Testing Patterns

### Mocking External Dependencies
```typescript
// API mocking
vi.mock('../../lib/api/gateways', () => ({
  gatewaysApi: {
    getAll: vi.fn(),
    create: vi.fn(),
    // ...
  }
}));

// Store mocking
vi.mock('../../stores/organization', () => ({
  useOrganizationStore: () => ({
    currentOrganization: mockOrganization
  })
}));
```

### Testing User Interactions
```typescript
const user = userEvent.setup();

// Click interactions
await user.click(screen.getByRole('button', { name: 'Create Gateway' }));

// Form interactions
await user.type(screen.getByLabelText('Gateway Name'), 'Test Gateway');
await user.selectOptions(screen.getByRole('combobox'), 'mcp');
```

### Async Testing
```typescript
await waitFor(() => {
  expect(screen.getByText('Expected Text')).toBeInTheDocument();
});
```

## 🔍 Debugging Tests

### Backend Debugging
```bash
# Run specific test with debug info
npm test -- --verbose gateway.entity.spec.ts

# Debug mode
npm run test:debug
```

### Frontend Debugging  
```bash
# Run tests in browser (UI mode)
npm run test:ui

# Debug specific test
npm test -- --run --reporter=verbose data-table.test.tsx
```

### E2E Debugging
```bash
# Interactive debugging
npm run test:e2e:debug

# Generate trace files
npx playwright test --trace on

# View traces
npx playwright show-trace trace.zip
```

## 📈 Continuous Integration

### GitHub Actions Example
```yaml
name: Test Suite
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      
      - name: Install dependencies
        run: npm run setup
        
      - name: Run linting
        run: npm run lint
        
      - name: Run backend tests
        run: npm run test:backend
        
      - name: Run frontend tests  
        run: npm run test:frontend
        
      - name: Install Playwright
        run: npm run playwright:install
        
      - name: Run E2E tests
        run: npm run test:e2e
        
      - name: Upload coverage
        uses: codecov/codecov-action@v3
```

## ✅ Test Checklist

Before deploying, ensure:

- [ ] All unit tests pass (`npm run test:backend`)
- [ ] All component tests pass (`npm run test:frontend`) 
- [ ] All E2E tests pass (`npm run test:e2e`)
- [ ] Coverage thresholds are met (80%+)
- [ ] Linting passes (`npm run lint`)
- [ ] Build succeeds (`npm run build`)
- [ ] Scoping functionality is thoroughly tested
- [ ] All 3 protocol types work correctly
- [ ] No references to SCOPED_TOOL gateway type

## 🎉 Success Metrics

A successful test run should show:
- **Backend**: 80%+ coverage across all metrics
- **Frontend**: 75%+ coverage across all metrics  
- **E2E**: All critical user workflows pass
- **Cross-browser**: Tests pass on Chrome, Firefox, Safari
- **Mobile**: Tests pass on mobile viewports

## 🚀 Production Ready

When all tests pass, the system is **production ready** with:
- ✅ Comprehensive test coverage
- ✅ All protocols working (MCP, A2A, UTCP)
- ✅ Scoping functionality validated
- ✅ UI/UX thoroughly tested
- ✅ Error handling verified
- ✅ Cross-platform compatibility