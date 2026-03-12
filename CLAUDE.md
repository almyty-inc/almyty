# apifai - Developer Reference

## Project Overview

**apifai** is a universal API-to-AI tool gateway. It parses API schemas (OpenAPI, GraphQL, SOAP, Protobuf), auto-generates tools, and serves them via MCP, UTCP, and A2A protocols.

**Last active**: March 12, 2026. **Project started**: November 5, 2025.

---

## Tech Stack

### Backend
- **Framework**: NestJS 10.3 + TypeScript 5.3
- **Database**: PostgreSQL 16 (TypeORM 0.3)
- **Cache**: Redis 7
- **Queue**: BullMQ (async schema import, tool generation)
- **Auth**: Passport + JWT + bcrypt
- **Health**: @nestjs/terminus (liveness, readiness, full health)
- **Port**: 3000

### Frontend
- **Framework**: React 18.2 + TypeScript + Vite 5
- **UI**: shadcn/ui (Radix UI primitives) + Tailwind CSS 3.4
- **State**: Zustand 4.4 + TanStack React Query 5
- **Tables**: TanStack React Table 8
- **Forms**: react-hook-form + zod
- **Production**: nginx 1.25 serving static build on port 8080
- **Port**: 3002 (dev), 8080 (production/nginx)

### Infrastructure
- **Docker**: Multi-stage Dockerfiles (node:22-alpine for backend, nginx:1.25-alpine for frontend)
- **Docker Compose**: postgres, redis, backend, frontend, nginx (local dev)
- **Kubernetes**: Kustomize base + 3 overlays (development, staging, production)
- **CI/CD**: 5 GitHub Actions workflows (production, staging, dev, quick-api, quick-frontend)
- **Registry**: ghcr.io/frane/apifai
- **Cloud**: DigitalOcean Kubernetes
- **Domain**: apif.ai (primary)
- **TLS**: Let's Encrypt via cert-manager
- **Testing**: Playwright for E2E, Jest for backend unit/integration

---

## Live Environments

| Environment | API | Frontend | Database | Deploy Trigger |
|-------------|-----|----------|----------|----------------|
| **Dev** | https://api.dev.apif.ai | https://app.dev.apif.ai | In-cluster postgres (ephemeral) | Push to `develop` |
| **Staging** | https://api.staging.apif.ai | https://app.staging.apif.ai | DO Managed PostgreSQL (persistent) | Push to `master` |
| **Production** | https://api.apif.ai | https://app.apif.ai | DO Managed PostgreSQL (not yet provisioned) | Tag `v*.*.*` |

---

## Codebase Structure

```
backend/src/
├── entities/          # 24 TypeORM entities
├── modules/
│   ├── apis/          # API CRUD, schema import
│   ├── auth/          # JWT auth, registration, login
│   ├── gateways/      # Gateway CRUD, tool scoping, protocol serving, exports
│   ├── health/        # @nestjs/terminus: /health, /health/live, /health/ready
│   ├── jobs/          # BullMQ background jobs
│   ├── json-schema-translator/
│   ├── llm-providers/ # OpenAI, Anthropic integration
│   ├── mcp/           # MCP JSON-RPC 2.0 (HTTP, SSE, WebSocket) + real prompts
│   ├── monitoring/    # Metrics, usage tracking
│   ├── organizations/ # Multi-tenancy, RBAC, teams
│   ├── plugins/       # Plugin architecture
│   ├── schema-parser/ # 4 parsers: OpenAPI, GraphQL, SOAP, Protobuf
│   ├── tools/         # Tool CRUD, generation, execution (real HTTP via axios)
│   └── users/         # User management
└── 90 test suites     # 3,003 backend tests, 0 failures

frontend/src/
├── pages/             # 14 pages + auth
├── components/        # 20 shadcn/ui components
├── hooks/             # React Query hooks
├── lib/               # API client (with 401 interceptor), utilities
├── stores/            # Zustand stores
└── types/             # TypeScript types

frontend/tests/e2e/
└── 15 spec files      # 190 Playwright tests

k8s/
├── base/              # Namespace, configmap, deployments, services, ingress, cert-manager
├── overlays/
│   ├── development/   # In-cluster postgres, 1 replica, debug logging
│   ├── staging/       # Managed DB, 2 replicas, swagger enabled
│   └── production/    # Managed DB, 3 API replicas, manual approval deploy
└── redirect-ingress.yaml  # 301 redirects: apifai.ai + apifai.com → apif.ai

.github/workflows/
├── deploy-production.yml  # Tag v*.*.* → build → manual approval → deploy + GitHub Release
├── deploy-staging.yml     # Push to master → auto-deploy staging + redirect ingress
├── deploy-development.yml # Push to develop → auto-deploy dev
├── deploy-api.yml         # Quick API-only deploy (backend/** changes on master)
└── deploy-frontend.yml    # Quick frontend-only deploy (frontend/** changes on master)
```

---

## Key Facts (Verified March 2026)

- **Entities**: 24 (User, Organization, Team, Api, ApiSchema, Operation, Resource, Tool, ToolVersion, ToolCategory, ToolExecution, Gateway, GatewayTool, GatewayAuth, LlmProvider, LlmSession, LlmMessage, RequestLog, UsageMetric, JsonSchema, ApiKey, Credential, UserOrganization, UserTeam)
- **Gateway types**: 3 — `MCP`, `A2A`, `UTCP` (scoping via tool assignment)
- **Backend tests**: 90 suites, 3,003 tests, 0 failures
- **E2E tests**: 190 across 15 files, 90s timeout per test
- **Petstore pipeline**: Verified — 20 operations parsed, 20 tools generated, served via MCP
- **Tool execution**: Real HTTP calls via axios (not stubs)
- **MCP prompts**: Real implementation generating prompts from org tools

---

## What Works (All Verified)

- Full auth flow (registration, login, JWT, 401 interceptor)
- API CRUD with schema import (OpenAPI verified end-to-end with Petstore)
- Tool auto-generation from parsed schemas
- Tool execution: real HTTP calls via axios to target APIs
- MCP protocol: JSON-RPC 2.0 with session management, multi-transport, real prompts
- UTCP and A2A protocol endpoints (real implementations)
- Gateway exports: skills, CLI bundles, SDK generation
- Frontend: all pages functional (dashboard, APIs, tools, gateways, analytics, settings, orgs)
- Organization settings: editable name/description with save
- Protocol discovery: `/.well-known/mcp`, `/.well-known/utcp`
- Health checks: `/health` (full), `/health/live` (liveness), `/health/ready` (readiness)
- Graceful shutdown (SIGTERM handling for k8s)
- Global rate limiting (ThrottlerGuard)
- Docker deployment with production-grade multi-stage builds
- Kubernetes: dev + staging deployed and healthy
- GitHub Actions CI/CD: fully automated deploys on push
- TLS: real Let's Encrypt certs on all environments
- Domain redirects: apifai.ai + apifai.com → apif.ai (301)

---

## Ports

| Service | Dev Port | Container Port | Notes |
|---------|----------|---------------|-------|
| Backend | 4000 (host) | 3000 | docker-compose maps 4000:3000 |
| Frontend | 3002 (dev) | 8080 (nginx) | Vite dev server / nginx production |
| PostgreSQL | 5432 | 5432 | |
| Redis | 6379 | 6379 | |

---

## Database Configuration

TypeORM connects via individual params (not DATABASE_URL) for proper SSL control:
- `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_USERNAME`, `DATABASE_PASSWORD`, `DATABASE_NAME`
- `DB_SSL` env var: `"true"` for managed databases, `"false"` for local dev

---

## Secrets Management

Secrets are **NOT stored in git**. They are managed via:
- **GitHub Secrets** → injected by CI/CD workflows
- **k8s secrets** → created at deploy time
- See `.github/workflows/` for secret references

---

## Commands

```bash
# Start everything (local dev)
docker-compose up -d

# Frontend dev
cd frontend && PORT=3002 npm run dev

# Backend tests (90 suites, 3,003 tests)
cd backend && npm run test
cd backend && npm run test:cov

# E2E tests
cd frontend && E2E_BASE_URL=http://localhost:3002 npx playwright test --reporter=list

# Health checks (local)
curl http://localhost:4000/health          # Full health (DB + Redis + memory)
curl http://localhost:4000/health/live     # Liveness (memory only)
curl http://localhost:4000/health/ready    # Readiness (DB + Redis)

# Health checks (staging)
curl https://api.staging.apif.ai/health

# MCP discovery
curl http://localhost:4000/api/mcp/.well-known/mcp

# Validate k8s manifests
kubectl kustomize k8s/overlays/development
kubectl kustomize k8s/overlays/staging
kubectl kustomize k8s/overlays/production

# Docker production builds
docker build --target production -t apifai-api:test ./backend
docker build --target production -t apifai-frontend:test --build-arg VITE_API_BASE_URL=http://localhost:3000 ./frontend
```

---

## Deployment

### Staging Deploy (auto on push to master)
```bash
git push origin master
# GitHub Actions: builds images → creates secrets → deploys to k8s + redirect ingress
```

### Development Deploy (auto on push to develop)
```bash
git push origin develop
# GitHub Actions: builds images → deploys to k8s
```

### Production Deploy (manual tag)
```bash
git tag v1.0.0
git push origin v1.0.0
# GitHub Actions: builds images → manual approval gate → deploys to k8s → creates GitHub Release
```

---

## Design Documents

- `docs/architecture.md` — System architecture
- `docs/implementation-plan.md` — Original implementation plan
- `docs/schema-design.md` — Database schema design
