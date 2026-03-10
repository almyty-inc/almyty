# apifai E2E Test Suite

Playwright-based end-to-end tests running against the real backend (no mocks).

---

## Running Tests

### Prerequisites
```bash
# Start backend services
docker-compose up -d postgres redis backend

# Start frontend dev server
cd frontend && PORT=3002 npm run dev
```

### Run Tests
```bash
cd frontend

npm run test:e2e              # Headless
npm run test:e2e:headed       # With browser visible
npm run test:e2e:debug        # Debug mode with slow-mo
npm run test:e2e:ui           # Interactive UI mode
```

### Run Specific Tests
```bash
npm run test:e2e -- auth-*                  # Auth tests only
npm run test:e2e -- apis-*                  # API tests only
npm run test:e2e -- gateways-crud-scoping   # Gateway scoping tests
npm run test:e2e -- --grep "CRITICAL"       # Critical bug tests
```

---

## Test Suites (190 tests across 15 files)

| File | Tests | Coverage |
|------|-------|----------|
| `analytics.spec.ts` | 16 | Metrics, charts, filters, export |
| `apis-crud.spec.ts` | 14 | Create/edit/delete APIs, search, validation |
| `apis-schema-import.spec.ts` | 12 | Import Petstore, URL/file upload, tool generation |
| `auth-login.spec.ts` | 12 | Login flow, validation, session persistence |
| `auth-registration.spec.ts` | 12 | Registration, field validation, duplicate handling |
| `auth-session.spec.ts` | 8 | Logout, token clearing, protected routes |
| `complete-workflow.spec.ts` | 1 | Full pipeline: API -> Schema -> Tools -> Gateway -> Execute |
| `dashboard.spec.ts` | 15 | Stats cards, quick actions, navigation |
| `gateway-management.spec.ts` | 9 | Gateway CRUD, type validation |
| `gateways-crud-scoping.spec.ts` | 15 | Create gateways (MCP/A2A/UTCP), tool scoping |
| `llm-providers.spec.ts` | 18 | Provider config, connection testing, models |
| `organizations.spec.ts` | 13 | Org management, members, teams, roles |
| `settings.spec.ts` | 20 | Profile, organization settings, security |
| `tools-generation-execution.spec.ts` | 10 | Tool generation from schemas, execution |
| `tools-list.spec.ts` | 15 | Tool display, search, filter, toggle, delete |

---

## Configuration

From `playwright.config.ts`:
- **Test timeout**: 90 seconds
- **Expect timeout**: 10 seconds
- **Action timeout**: 15 seconds
- **Navigation timeout**: 30 seconds
- **Workers**: 1 (sequential to avoid DB conflicts)
- **Browser**: Chromium
- **Screenshots/video**: On failure

---

## Test Helpers

### AuthHelper
```typescript
const authHelper = new AuthHelper(page)
await authHelper.registerViaAPI(testUser)
await authHelper.loginViaAPI(email, password)
const testUser = AuthHelper.generateTestUser()
```

### APIHelper
```typescript
const apiHelper = new APIHelper()
await apiHelper.createAPI({ name, baseUrl, type })
await apiHelper.importSchema(apiId, { schemaUrl, generateTools: true })
await apiHelper.createGateway({ name, type, endpointPath })
await apiHelper.assignToolToGateway(gatewayId, toolId)
```

### AssertionsHelper
```typescript
const assertHelper = new AssertionsHelper(page)
await assertHelper.assertOnDashboard()
await assertHelper.assertToastMessage(/success/i)
await assertHelper.assertDialogOpen(/create api/i)
```

---

## Test Data

```typescript
import { TEST_APIS } from './fixtures/test-data'
TEST_APIS.PETSTORE        // Petstore with 20 operations -> 20 tools
TEST_APIS.JSONPLACEHOLDER // Simple REST API
```

---

## Notes

- **Real backend required**: Tests connect to `http://localhost:4000/api`
- **Database state**: Tests create real data, cleanup in `globalTeardown`
- **Sequential execution**: Workers: 1 to avoid DB conflicts
- **No mocks**: All tests hit the real backend
- **Gateway types**: Only 3 — MCP, A2A, UTCP (SCOPED_TOOL was removed; scoping is via tool assignment)
- **Known timeout issues**: Some tests hit 90s limit due to slow async operations (schema import, tool generation)
