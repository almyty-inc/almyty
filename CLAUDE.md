# almyty - Developer Reference

## Project Overview

**almyty** is an open platform for building, deploying, and running AI agents. It parses API schemas (OpenAPI, GraphQL, SOAP, Protobuf), auto-generates tools, and lets users compose multi-LLM agent pipelines with a visual builder. Agents and tools are served via MCP, A2A, UTCP, Agent Skills, and an OpenAI-compatible API. Users can also create custom tools manually (HTTP, JavaScript, GraphQL, LLM-powered).

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
- **Port**: 3002 (dev), 8080 (production/nginx)

### Infrastructure
- **Docker**: Multi-stage Dockerfiles (node:22-alpine, nginx:1.25-alpine)
- **Docker Compose**: postgres, redis, backend, frontend, nginx
- **Kubernetes**: Kustomize base + 3 overlays (development, staging, production)
- **CI/CD**: GitHub Actions (5 workflows)
- **TLS**: Let's Encrypt via cert-manager

---

## Codebase Structure

```
backend/src/
├── entities/          # 24 TypeORM entities
├── modules/
│   ├── apis/          # API CRUD, schema import
│   ├── auth/          # JWT auth, registration, login
│   ├── gateways/      # Gateway CRUD, tool scoping, protocol serving, exports
│   ├── health/        # /health, /health/live, /health/ready
│   ├── jobs/          # BullMQ background jobs
│   ├── llm-providers/ # OpenAI, Anthropic integration
│   ├── mcp/           # MCP JSON-RPC 2.0 (HTTP, SSE, WebSocket)
│   ├── monitoring/    # Metrics, usage tracking
│   ├── organizations/ # Multi-tenancy, RBAC
│   ├── schema-parser/ # 4 parsers: OpenAPI, GraphQL, SOAP, Protobuf
│   ├── tools/         # Tool CRUD, generation, execution, skill export
│   └── users/         # User management

frontend/src/
├── pages/             # Dashboard, APIs, Tools, Gateways, Agents, Chat, etc.
├── components/        # shadcn/ui components
├── hooks/             # React Query hooks
├── lib/               # API client, utilities
├── stores/            # Zustand stores
└── types/             # TypeScript types

packages/skills-cli/   # npx @almyty/skills CLI
├── src/
│   ├── index.ts       # CLI entry (install, watch, list, remove)
│   ├── agents.ts      # 30+ agent detection
│   ├── installer.ts   # SKILL.md file writer
│   ├── client.ts      # HTTP client to backend
│   └── auth.ts        # JWT authentication
```

---

## Key Facts

- **Entities**: 24 (User, Organization, Team, Api, ApiSchema, Operation, Resource, Tool, ToolVersion, ToolCategory, ToolExecution, Gateway, GatewayTool, GatewayAuth, LlmProvider, LlmSession, LlmMessage, RequestLog, UsageMetric, JsonSchema, ApiKey, Credential, UserOrganization, UserTeam)
- **Gateway types**: MCP, A2A, UTCP, Skills
- **Tool types**: API (auto-generated), HTTP, JavaScript (sandboxed), GraphQL, LLM
- **Backend tests**: 90 suites, 3,000+ tests
- **Agent Skills**: Compliant with https://agentskills.io spec

---

## Ports

| Service | Dev Port | Container Port |
|---------|----------|---------------|
| Backend | 4000 (host) | 3000 |
| Frontend | 3002 (dev) | 8080 (nginx) |
| PostgreSQL | 5432 | 5432 |
| Redis | 6379 | 6379 |

---

## Database Configuration

TypeORM connects via individual params:
- `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_USERNAME`, `DATABASE_PASSWORD`, `DATABASE_NAME`
- `DB_SSL`: `"true"` for managed databases, `"false"` for local dev

---

## Commands

```bash
# Start everything (local dev)
docker-compose up -d

# Frontend dev
cd frontend && PORT=3002 npm run dev

# Backend tests
cd backend && npm run test

# Health check
curl http://localhost:4000/health

# Skills CLI
npx @almyty/skills install --gateway <id>
npx @almyty/skills watch --gateway <id>

# Docker production builds
docker build --target production -t almyty-api ./backend
docker build --target production -t almyty-frontend ./frontend
```

---

## Design Documents

- `docs/architecture.md` — System architecture
- `docs/implementation-plan.md` — Original implementation plan
- `docs/schema-design.md` — Database schema design

---

## Brand: Almyty

- Always lowercase `almyty` in code and text. Capitalize `Almyty` only at sentence start.
- ⚡ emoji is a community brand character (README, changelogs, social). Never in formal docs or the SVG logo.
- Logo: hollow ⚡ polygon, thin circuit strokes (1.5px) + node dots, violet→cyan gradient. Never filled solid.
- Primary: violet-500 `#8b5cf6` (dark) / violet-600 `#7C3AED` (light)
- Accent: cyan-400 `#22d3ee` (dark) / cyan-600 `#0891B2` (light)
- Fonts: Manrope (headings + logo), DM Sans (body), JetBrains Mono (code). All Google Fonts, SIL OFL.
- Dark bg: `#09090b` / Card: `#18181b` / Muted: `#27272a`
- Light bg: `#FFFFFF` / Muted: `#F4F4F5` / Border: `#E4E4E7`
- Dark borders: solid `#27272a`, never semi-transparent
- Primary text dark: `#FAFAFA`, secondary: `#A1A1AA`, muted: `#71717A`
- Terminal prompt in examples: violet (`#8b5cf6`). Shell prompt: `$`
- Protocol badges: MCP=violet, A2A=cyan, UTCP=emerald, SOAP=amber, GraphQL=rose, REST=blue
- Primary CTA buttons use violet→cyan gradient. Secondary buttons solid violet. One gradient CTA per page max.
- Sidebar order: Dashboard → APIs → Tools → Gateways → Agents → Models → Analytics → Settings
