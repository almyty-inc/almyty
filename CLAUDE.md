# apifai - Developer Reference

## Project Overview

**apifai** is a universal API-to-AI tool gateway. It parses API schemas (OpenAPI, GraphQL, SOAP, Protobuf), auto-generates tools, and serves them via MCP, UTCP, and A2A protocols.

**Last active**: November 27, 2025. **Project started**: November 5, 2025.

---

## Tech Stack

### Backend
- **Framework**: NestJS 10.3 + TypeScript 5.3
- **Database**: PostgreSQL 15 (TypeORM 0.3)
- **Cache**: Redis 7
- **Queue**: BullMQ (async schema import, tool generation)
- **Auth**: Passport + JWT + bcrypt
- **Port**: 4000

### Frontend
- **Framework**: React 18.2 + TypeScript + Vite 5
- **UI**: shadcn/ui (Radix UI primitives) + Tailwind CSS 3.4
- **State**: Zustand 4.4 + TanStack React Query 5
- **Tables**: TanStack React Table 8
- **Forms**: react-hook-form + zod
- **Port**: 3002 (dev)

### Infrastructure
- Docker Compose: postgres, redis, backend, frontend, nginx
- Playwright for E2E testing

---

## Codebase Structure

```
backend/src/
├── entities/          # 24 TypeORM entities
├── modules/
│   ├── apis/          # API CRUD, schema import
│   ├── auth/          # JWT auth, registration, login
│   ├── gateways/      # Gateway CRUD, tool scoping, protocol serving
│   ├── jobs/          # BullMQ background jobs
│   ├── json-schema-translator/
│   ├── llm-providers/ # OpenAI, Anthropic integration
│   ├── mcp/           # MCP JSON-RPC 2.0 (HTTP, SSE, WebSocket)
│   ├── monitoring/    # Health checks, metrics
│   ├── organizations/ # Multi-tenancy, RBAC, teams
│   ├── plugins/       # Plugin architecture
│   ├── schema-parser/ # 4 parsers: OpenAPI, GraphQL, SOAP, Protobuf
│   ├── tools/         # Tool CRUD, generation, execution
│   └── users/         # User management
└── 83 .spec.ts files  # Backend unit/integration tests

frontend/src/
├── pages/             # 14 pages + auth
├── components/        # 20 shadcn/ui components
├── hooks/             # React Query hooks
├── lib/               # API client, utilities
├── stores/            # Zustand stores
└── types/             # TypeScript types

frontend/tests/e2e/
└── 15 spec files      # 190 Playwright tests
```

---

## Key Facts (Verified)

- **Entities**: 24 (User, Organization, Team, Api, ApiSchema, Operation, Resource, Tool, ToolVersion, ToolCategory, ToolExecution, Gateway, GatewayTool, GatewayAuth, LlmProvider, LlmSession, LlmMessage, RequestLog, UsageMetric, JsonSchema, ApiKey, Credential, UserOrganization, UserTeam)
- **Gateway types**: 3 only — `MCP`, `A2A`, `UTCP` (no SCOPED_TOOL — scoping is done via tool assignment)
- **E2E tests**: 190 across 15 files, 90s timeout per test, sequential execution
- **Backend tests**: 83 spec files, ~51% coverage
- **Petstore pipeline**: Verified working — 20 operations parsed, 20 tools generated, served via MCP

---

## What Works

- Full auth flow (registration, login, JWT)
- API CRUD with schema import (OpenAPI verified end-to-end with Petstore)
- Tool auto-generation from parsed schemas
- MCP protocol: JSON-RPC 2.0 with session management, multi-transport
- UTCP and A2A protocol endpoints
- Frontend: all pages functional (dashboard, APIs, tools, gateways, analytics, settings, orgs)
- Protocol discovery: `/.well-known/mcp`, `/.well-known/utcp`
- Docker deployment (5 services)
- Database indexes added for performance (13 indexes)

## What Needs Work

### Bugs
1. **Auth token expiration**: No 401 response interceptor in frontend API client. Needs interceptor to redirect to login or refresh token.
2. **E2E network mocking**: 2 tests fail due to Playwright route mocking issues (test infra, not app).

### Performance
- API operations improved from ~17s to ~2s with indexing, but need load testing
- Schema import uses async BullMQ jobs — polling can be slow
- Some E2E tests still hit 90s timeout under cumulative load

### Coverage
- Backend test coverage at ~51%, target 80%+
- Many service modules have spec files but thin coverage

---

## Commands

```bash
# Start everything
docker-compose up -d

# Frontend dev
cd frontend && PORT=3002 npm run dev

# Backend tests
cd backend && npm run test
cd backend && npm run test:cov

# E2E tests
cd frontend && E2E_BASE_URL=http://localhost:3002 npx playwright test --reporter=list

# Health check
curl http://localhost:4000/api/monitoring/health

# MCP discovery
curl http://localhost:4000/api/mcp/.well-known/mcp
```

---

## Design Documents

- `llm-tool-gateway-architecture.md` — System architecture
- `llm-tool-gateway-implementation-plan.md` — Original implementation plan
- `llm-tool-gateway-schema.md` — Database schema design
