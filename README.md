# apifai

> Universal API-to-AI Tool Gateway

**apifai** translates any API format (OpenAPI, GraphQL, SOAP, Protobuf) into AI-consumable tools served via multiple protocols (MCP, UTCP, A2A).

**Status**: Production-ready. Deployed on DigitalOcean Kubernetes with CI/CD, TLS, and 3 environments.

---

## Quick Start

### Prerequisites
- Node.js 22+
- Docker & Docker Compose

### 1. Start Services
```bash
git clone https://github.com/frane/apifai.git
cd apifai
docker-compose up -d
curl http://localhost:4000/health
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
curl -X POST http://localhost:4000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"Test123456","firstName":"Test","lastName":"User","organizationName":"TestOrg"}'

TOKEN=$(curl -s -X POST http://localhost:4000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"Test123456"}' | jq -r '.accessToken')

# Create API
API_ID=$(curl -s -X POST http://localhost:4000/apis \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Petstore","baseUrl":"https://petstore3.swagger.io/api/v3","type":"openapi","authentication":{"type":"none","config":{}}}' | jq -r '.id')

# Import schema and generate tools
curl -X POST http://localhost:4000/apis/$API_ID/import-schema \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"schemaUrl":"https://petstore3.swagger.io/api/v3/openapi.json","generateTools":true}'

# List tools via MCP
curl -X POST http://localhost:4000/api/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

---

## Architecture

```
Frontend (React + shadcn/ui)         Port 3002 (dev) / 8080 (nginx)
        |
API Backend (NestJS)                 Port 3000 (container) / 4000 (docker host)
        |
+-------+-----------+
|       |           |
MCP    UTCP        A2A               Protocol Endpoints
|       |           |
+-------+-----------+
        |
Schema Parsers: OpenAPI, GraphQL, SOAP, Protobuf
        |
PostgreSQL 16 + Redis 7 + BullMQ    Data Layer
```

### Backend (NestJS + TypeScript)
- **15 modules**: Auth, Users, Organizations, APIs, Tools, Gateways, SchemaParser, JsonSchemaTranslator, LlmProviders, MCP, Jobs, Plugins, Monitoring, Health, GatewayTool
- **24 TypeORM entities**: Users, Organizations, Teams, APIs, Operations, Tools, Gateways, and more
- **4 schema parsers**: OpenAPI/Swagger, GraphQL, SOAP/WSDL, Protobuf
- **3 protocol implementations**: MCP (JSON-RPC 2.0), UTCP (HTTP), A2A (Agent-to-Agent)
- **90 backend test files**, 3,003 tests

### Frontend (React + Vite + shadcn/ui)
- **14 pages**: Dashboard, APIs, API Detail, Tools, Tool Detail, Gateways, Gateway Detail, Analytics, Organizations, Settings, LLM Providers, Auth (Login/Register)
- **20 shadcn/ui components** built on Radix UI primitives
- **State**: Zustand + TanStack React Query
- **Styling**: Tailwind CSS

### MCP Server (`packages/mcp-server/`)
- **Skill-first MCP proxy**: 2 tools (`apifai_execute` + `apifai_search`) instead of N tool schemas
- **Token overhead**: ~300 tokens (fixed) vs ~4,000+ (traditional MCP)
- **Supports**: Claude Code, Cursor, GitHub Copilot, Codex CLI, Gemini CLI

### Infrastructure
- **Docker**: Multi-stage Dockerfiles (node:22-alpine backend, nginx:1.25-alpine frontend)
- **Kubernetes**: Kustomize base + 3 overlays (development, staging, production)
- **CI/CD**: 5 GitHub Actions workflows (production, staging, dev, quick-api, quick-frontend)
- **Cloud**: DigitalOcean Kubernetes (3 nodes, fra1 region)
- **Domain**: apif.ai (primary), apifai.ai + apifai.com (301 redirect to apif.ai)
- **TLS**: Let's Encrypt via cert-manager (HTTP-01 challenge)
- **Registry**: ghcr.io/frane/apifai

---

## Live Environments

| Environment | API | Frontend | Database | Deploy Trigger |
|-------------|-----|----------|----------|----------------|
| **Dev** | https://api.dev.apif.ai | https://app.dev.apif.ai | In-cluster postgres (ephemeral) | Push to `develop` |
| **Staging** | https://api.staging.apif.ai | https://app.staging.apif.ai | DO Managed PostgreSQL | Push to `master` |
| **Production** | https://api.apif.ai | https://app.apif.ai | DO Managed PostgreSQL | Tag `v*.*.*` |

---

## Feature Status

| Feature | Status | Details |
|---------|--------|---------|
| API Schema Parsing | Working | 4 parsers (OpenAPI, GraphQL, SOAP, Protobuf) |
| Tool Auto-generation | Working | 20 tools from Petstore verified |
| Tool Execution | Working | Real HTTP calls via axios (not stubs) |
| MCP Protocol | Working | JSON-RPC 2.0, session management, multi-transport (HTTP, SSE, WebSocket) |
| UTCP Protocol | Working | Direct HTTP tool calling |
| A2A Protocol | Working | Agent-to-agent communication |
| Authentication | Working | JWT + refresh tokens, 401 interceptor, API keys |
| Frontend UI | Working | Full CRUD for APIs, Tools, Gateways, Organizations |
| Analytics Dashboard | Working | Metrics, usage tracking, enterprise dashboard |
| Gateway Scoping | Working | Selective tool assignment, security policies |
| Gateway Exports | Working | Skills, CLI bundles (bash/node), TypeScript SDK |
| LLM Providers | Working | OpenAI, Anthropic, Google, Cohere, HuggingFace, Azure, Bedrock |
| Multi-tenancy | Working | Organizations, teams, RBAC |
| Health Checks | Working | `/health`, `/health/live`, `/health/ready` (K8s probes) |
| Docker Deployment | Working | Production-grade multi-stage builds |
| Kubernetes | Working | Dev + staging deployed and healthy |
| CI/CD | Working | 5 GitHub Actions workflows, auto-deploy |
| TLS | Working | Real Let's Encrypt certs on all environments |
| Domain Redirects | Working | apifai.ai + apifai.com -> apif.ai (301) |

---

## Testing

### E2E Tests (Playwright)
**190 tests across 15 test files**, running against the real backend.

| Test Suite | Tests |
|-----------|-------|
| analytics.spec.ts | 16 |
| apis-crud.spec.ts | 14 |
| apis-schema-import.spec.ts | 12 |
| auth-login.spec.ts | 12 |
| auth-registration.spec.ts | 12 |
| auth-session.spec.ts | 8 |
| complete-workflow.spec.ts | 1 |
| dashboard.spec.ts | 15 |
| gateway-management.spec.ts | 9 |
| gateways-crud-scoping.spec.ts | 15 |
| llm-providers.spec.ts | 18 |
| organizations.spec.ts | 13 |
| settings.spec.ts | 20 |
| tools-generation-execution.spec.ts | 10 |
| tools-list.spec.ts | 15 |

Test timeout: 90 seconds per test. Tests run sequentially (workers: 1).

```bash
cd frontend
E2E_BASE_URL=http://localhost:3002 npx playwright test --reporter=list
```

### Backend Tests
90 spec files, 3,003 tests, 0 failures.

```bash
cd backend
npm run test
npm run test:cov
```

---

## Deployment

### Staging (auto on push to master)
```bash
git push origin master
# GitHub Actions: builds images -> creates secrets -> deploys to k8s + redirect ingress
```

### Development (auto on push to develop)
```bash
git push origin develop
# GitHub Actions: builds images -> deploys to k8s
```

### Production (manual tag + approval gate)
```bash
git tag v1.0.0
git push origin v1.0.0
# GitHub Actions: builds images -> manual approval -> deploys to k8s -> creates GitHub Release
```

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

### Health Checks
```bash
curl http://localhost:4000/health          # Full health (DB + Redis + memory)
curl http://localhost:4000/health/live     # Liveness (memory only)
curl http://localhost:4000/health/ready    # Readiness (DB + Redis)
```

### Protocol Discovery
```bash
curl http://localhost:4000/api/mcp/.well-known/mcp
```

### Validate K8s Manifests
```bash
kubectl kustomize k8s/overlays/development
kubectl kustomize k8s/overlays/staging
kubectl kustomize k8s/overlays/production
```

### Docker Production Builds
```bash
docker build --target production -t apifai-api:test ./backend
docker build --target production -t apifai-frontend:test --build-arg VITE_API_BASE_URL=http://localhost:3000 ./frontend
```

---

## Design Documents

Architecture and design docs are in `docs/`:
- `docs/architecture.md` - System architecture
- `docs/implementation-plan.md` - Implementation roadmap
- `docs/schema-design.md` - Database schema design

---

## License

BSL-1.1
