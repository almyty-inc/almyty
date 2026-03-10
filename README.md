# apifai

> Universal API-to-AI Tool Gateway

**apifai** translates any API format (OpenAPI, GraphQL, SOAP, Protobuf) into AI-consumable tools served via multiple protocols (MCP, UTCP, A2A).

**Status**: Core functionality working. Performance optimization and production hardening needed.

---

## Quick Start

### Prerequisites
- Node.js 18+
- Docker & Docker Compose

### 1. Start Services
```bash
git clone https://github.com/frane/apifai.git
cd apifai
docker-compose up -d
curl http://localhost:4000/api/monitoring/health
```

### 2. Start Frontend (Development)
```bash
cd frontend
PORT=3002 npm run dev
```

Access at: http://localhost:3002

### 3. Test the Pipeline
```bash
# Register and login
curl -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"Test123456","firstName":"Test","lastName":"User"}'

TOKEN=$(curl -s -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"Test123456"}' | jq -r '.accessToken')

# Create API
API_ID=$(curl -s -X POST http://localhost:4000/api/apis \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Petstore","baseUrl":"https://petstore.swagger.io/v2","type":"openapi","authentication":{"type":"none","config":{}}}' | jq -r '.id')

# Import schema and generate tools
curl -X POST http://localhost:4000/api/apis/$API_ID/import-schema \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"schemaUrl":"https://petstore.swagger.io/v2/swagger.json","generateTools":true}'

# List tools via MCP
curl -X POST http://localhost:4000/api/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

---

## Architecture

```
Frontend (React + shadcn/ui)         Port 3002
        │
API Gateway (NestJS)                 Port 4000
        │
┌───────┼───────────┐
│       │           │
MCP    UTCP        A2A               Protocol Endpoints
│       │           │
└───────┼───────────┘
        │
Schema Parsers: OpenAPI, GraphQL, SOAP, Protobuf
        │
PostgreSQL + Redis + BullMQ          Data Layer
```

### Backend (NestJS + TypeScript)
- **13 modules**: API, Auth, Gateways, Jobs, JsonSchemaTranslator, LlmProviders, MCP, Monitoring, Organizations, Plugins, SchemaParser, Tools, Users
- **24 TypeORM entities**: Users, Organizations, Teams, APIs, Operations, Tools, Gateways, and more
- **4 schema parsers**: OpenAPI/Swagger, GraphQL, SOAP/WSDL, Protobuf
- **3 protocol implementations**: MCP (JSON-RPC 2.0), UTCP (HTTP), A2A (Agent-to-Agent)
- **83 backend test files** (.spec.ts)

### Frontend (React + Vite + shadcn/ui)
- **14 pages**: Dashboard, APIs, API Detail, Tools, Tool Detail, Gateways, Gateway Detail, Analytics, Organizations, Settings, LLM Providers, Auth (Login/Register)
- **20 shadcn/ui components** built on Radix UI primitives
- **State**: Zustand + TanStack React Query
- **Styling**: Tailwind CSS

### Infrastructure
- **PostgreSQL 15**: Primary database
- **Redis 7**: Cache and sessions
- **BullMQ**: Background job processing (schema import, tool generation)
- **Docker Compose**: 5 services (postgres, redis, backend, frontend, nginx)

---

## Feature Status

| Feature | Status | Details |
|---------|--------|---------|
| API Schema Parsing | Working | 4 parsers (OpenAPI, GraphQL, SOAP, Protobuf) |
| Tool Auto-generation | Working | 20 tools from Petstore verified |
| MCP Protocol | Working | JSON-RPC 2.0, session management, multi-transport |
| UTCP Protocol | Working | Direct HTTP tool calling |
| A2A Protocol | Working | Agent-to-agent communication |
| Authentication | Working | JWT, registration, login. Token expiration handling needs fix |
| Frontend UI | Working | Full CRUD for APIs, Tools, Gateways, Organizations |
| Analytics Dashboard | Working | 16/16 E2E tests passing |
| Gateway Scoping | Working | Selective tool assignment to gateways |
| Docker Deployment | Working | Full containerized stack |

---

## Testing

### E2E Tests (Playwright)
**190 tests across 15 test files**, running against the real backend.

| Test Suite | Tests | Notes |
|-----------|-------|-------|
| analytics.spec.ts | 16 | |
| apis-crud.spec.ts | 14 | |
| apis-schema-import.spec.ts | 12 | |
| auth-login.spec.ts | 12 | |
| auth-registration.spec.ts | 12 | |
| auth-session.spec.ts | 8 | |
| complete-workflow.spec.ts | 1 | Full pipeline: API -> Schema -> Tools -> Gateway |
| dashboard.spec.ts | 15 | |
| gateway-management.spec.ts | 9 | |
| gateways-crud-scoping.spec.ts | 15 | |
| llm-providers.spec.ts | 18 | |
| organizations.spec.ts | 13 | |
| settings.spec.ts | 20 | |
| tools-generation-execution.spec.ts | 10 | |
| tools-list.spec.ts | 15 | |

Test timeout: 90 seconds per test. Tests run sequentially (workers: 1).

```bash
cd frontend
E2E_BASE_URL=http://localhost:3002 npx playwright test --reporter=list
```

### Backend Tests
83 spec files. Last measured coverage: ~51%.

```bash
cd backend
npm run test
npm run test:cov
```

---

## Known Issues

### Performance
- API CRUD operations can be slow (improved from 17s to ~2s with indexing, but still needs work under load)
- Schema import relies on async BullMQ jobs with polling
- Some E2E tests hit the 90s timeout due to cumulative slow operations

### Bugs (2 confirmed)
1. **Auth token expiration**: Frontend doesn't handle 401 responses properly. Needs a response interceptor to redirect to login or refresh the token.
2. **Network error mocking**: 2 E2E tests fail due to Playwright network mocking issues (test infrastructure, not app bug).

---

## Development

### Run E2E Tests
```bash
docker-compose up -d
cd frontend
PORT=3002 npm run dev
# In another terminal:
E2E_BASE_URL=http://localhost:3002 npx playwright test --reporter=list
```

### Protocol Discovery
```bash
curl http://localhost:4000/api/mcp/.well-known/mcp
curl http://localhost:4000/api/utcp/.well-known/utcp
curl http://localhost:4000/api/monitoring/health
```

---

## Design Documents

Original architecture and design docs are in the repo root:
- `llm-tool-gateway-architecture.md` - System architecture
- `llm-tool-gateway-implementation-plan.md` - Implementation roadmap
- `llm-tool-gateway-schema.md` - Database schema design

---

## License

MIT
