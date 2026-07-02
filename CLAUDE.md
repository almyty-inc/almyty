# almyty - Developer Reference

## Project Overview

**almyty** is an open platform for building, deploying, and running AI agents. It parses API schemas (OpenAPI, GraphQL, SOAP, Protobuf, SDK), auto-generates tools, and lets users compose multi-LLM agent pipelines with a visual builder. Agents and tools are served via MCP, A2A, UTCP, Agent Skills, and an OpenAI-compatible API. Users can also create custom tools manually (HTTP, JavaScript, GraphQL, LLM-powered).

---

## Tech Stack

### Backend
- **Framework**: NestJS 11 + TypeScript 5.7
- **Database**: PostgreSQL 16 (TypeORM 0.3)
- **Cache**: Redis 7
- **Queue**: BullMQ (async schema import, tool generation)
- **Auth**: httpOnly cookie + JWT + bcrypt (no localStorage tokens)
- **Health**: @nestjs/terminus (liveness, readiness, full health)
- **Port**: 3000

### Frontend
- **Framework**: React 18 + TypeScript + Vite 8
- **UI**: shadcn/ui (Radix UI primitives) + Tailwind CSS 3.4
- **State**: Zustand 4 + TanStack React Query 5
- **Tables**: TanStack React Table 8
- **Forms**: react-hook-form 7 + zod 3 + @hookform/resolvers 5
- **Agent Builder**: @xyflow/react (ReactFlow)
- **Port**: 3002 (dev), 8080 (production/nginx)

### Infrastructure
- **Docker**: Multi-stage Dockerfiles (node:24-alpine, nginx:1.25-alpine)
- **Docker Compose**: postgres, redis, backend, frontend, nginx
- **Kubernetes**: Kustomize base + 3 overlays (development, staging, production)
- **CI/CD**: GitHub Actions
- **TLS**: Let's Encrypt via cert-manager

---

## Codebase Structure

```
backend/src/
├── entities/          # 38 TypeORM entities
├── modules/
│   ├── agents/        # Agent CRUD, DAG execution engine, scheduler, webhooks, OpenAI-compat API
│   ├── apis/          # API CRUD, schema import
│   ├── audit-log/     # Audit trail for sensitive actions
│   ├── auth/          # JWT auth, registration, login, OAuth
│   ├── credentials/   # Credential storage + OAuth2 client flow
│   ├── files/         # File uploads / attachments
│   ├── gateways/      # Gateway CRUD, auth enforcement, protocol serving, unified endpoint
│   ├── health/        # /health, /health/live, /health/ready
│   ├── interfaces/    # Interface definition CRUD only — the 12 chat channel adapters live in gateways/channels/adapters/
│   ├── jobs/          # BullMQ background jobs
│   ├── json-schema-translator/ # JSON Schema conversion
│   ├── llm-providers/ # OpenAI, Anthropic, + 12 more provider integrations
│   ├── mail/          # Outbound email
│   ├── mcp/           # MCP, UTCP, A2A controllers + MCP OAuth 2.1 server + transports
│   ├── memory/        # Agent memory + embedding service
│   ├── monitoring/    # Metrics, usage tracking
│   ├── organizations/ # Multi-tenancy, RBAC
│   ├── plugins/       # Plugin system (5 built-in: rate-limiter, pii-filter, etc.)
│   ├── runner/        # Runner registration, FSM, dispatch resolution (cluster 5)
│   ├── workspace/     # Workspace lifecycle (active/released/expired/stranded), TTL sweep
│   ├── schema-parser/ # 5 parsers: OpenAPI, GraphQL, SOAP, Protobuf, SDK
│   ├── tool-hub/      # Tool catalog / discovery
│   ├── tools/         # Tool CRUD, generation, execution, skill export, JS sandbox
│   ├── users/         # User management
│   └── versions/      # Universal entity versioning (typeorm-versions)

frontend/src/
├── pages/             # Thin page shells — each page delegates to extracted components
├── components/
│   ├── ui/            # shadcn/ui primitives (skeleton, empty-state, query-error, data-table, etc.)
│   ├── agents/        # Agent builder + detail components (nodes/, builder/, detail/)
│   ├── analytics/     # Per-tab analytics components (7 tabs)
│   ├── apis/          # API list + detail components
│   ├── gateways/      # Gateway detail components
│   ├── llm-providers/ # Provider dialogs + columns
│   ├── tools/         # Tool dialogs
│   └── layout/        # DashboardLayout, AuthLayout
├── hooks/             # useCreateDeepLink, etc.
├── lib/               # API client (axios + withCredentials), clipboard helper, utilities
├── store/             # Zustand stores (auth, organization, app)
└── types/             # TypeScript types

packages/
├── almyty-cli/        # @almyty/cli — umbrella binary delegating to all CLIs below
├── auth-cli/          # @almyty/auth — browser-based login, token storage
├── agents-cli/        # @almyty/agents — list, run, inspect agents
├── chat-cli/          # @almyty/chat — interactive agent REPL
├── skills-cli/        # @almyty/skills — install API skills into 30+ AI coding agents
├── mcp-server/        # @almyty/mcp-server — skill-first MCP proxy
├── cli-tests/         # Smoke tests gated behind RUN_CLI_SMOKE=1
└── runner/            # @almyty/runner — long-running daemon that runs CLI agents on the user's machine
```

---

## Key Facts

- **Entities**: 38
- **Agent node types** (10): `input`, `output`, `llm_call`, `tool_call`, `condition`, `transform`, `loop`, `parallel`, `merge`, `sub_agent`
- **Gateway types**: MCP, A2A, UTCP, Skills
- **Tool types**: API (auto-generated), HTTP, JavaScript (sandboxed via worker_threads), GraphQL, LLM, SDK
- **LLM Providers**: 14 (OpenAI, Anthropic, Gemini, Azure, Bedrock, Vertex, Mistral, Cohere, Groq, Together, Perplexity, DeepSeek, Ollama, Custom)
- **Chat channel adapters**: 12, in `gateways/channels/adapters/` NOT `interfaces/` (Slack, Discord, Telegram, WhatsApp, Microsoft Teams, Google Chat, Signal, Matrix, IRC, Email, Webhook, Chat Widget). Shared pipeline + AI disclosure in `channel-gateway.service.ts`; Discord inbound via `discord-gateway.transport.ts`. Audit: `docs/interface-adapters-audit.md`
- **Built-in plugins**: 5 (performance-monitor, rate-limiter, pii-filter, request-logger, security-scanner)
- **Backend tests**: ~130 spec files, 4,108 passing (NestJS 11, Node 24). Real-integration specs in `src/test/integration/` require `RUN_DB_INTEGRATION=1`.
- **Frontend tests**: 127 vitest unit/integration tests + Playwright E2E suite (`frontend/tests/e2e/`)
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

# Frontend tests
cd frontend && npm test -- --run

# E2E tests against staging
cd frontend && npx playwright test --config=playwright.staging.config.ts

# Health check
curl http://localhost:4000/health

# CLI tools (authenticate once, all CLIs share ~/.almyty/credentials.json)
npx @almyty/auth login
npx @almyty/agents list
npx @almyty/skills install @org/gateway
npx @almyty/skills search "weather"
npx @almyty/chat my-agent

# CLI smoke tests (requires auth + at least one gateway with tools)
cd packages/cli-tests && RUN_CLI_SMOKE=1 npx vitest run

# Build + push to Docker Hub
docker build -t almyty/api ./backend && docker push almyty/api
docker build -t almyty/frontend ./frontend && docker push almyty/frontend
```

---

## Commit Messages

Keep commit messages concise and human-readable:
- **Subject line**: imperative mood, under 72 chars. Example: `fix login redirect loop on stale cookie`
- **Body** (optional): 1-3 short paragraphs explaining *why*, not a blow-by-blow of *what*. Skip obvious details.
- **Never include**: AI tool URLs, session IDs, marketing copy, test count boilerplate, or multi-page essays. The diff speaks for itself.
- **No emoji** in commit messages or code.
- **Do not** add `Co-authored-by` or attribution trailers.

---

## Deploy Pins (do not change)

- `.github/workflows/*.yml`: All GitHub Actions pinned to latest major — `docker/build-push-action@v7`, `docker/setup-buildx-action@v4`, `docker/login-action@v4`, `actions/checkout@v6`, `actions/setup-node@v6`, `dorny/paths-filter@v4`.
- `frontend/Dockerfile`: `nginx:1.25-alpine` is pinned.

---

## Auth

Tokens live in httpOnly cookies only. `withCredentials: true` on every axios call. **Never** write tokens to `localStorage` — this was fixed in a security audit and regression tests enforce it.

---

## Design Documents

- `docs/architecture.md` — System architecture
- `docs/brand/` — Color system, logo specs, typography

---

## Brand: Almyty

- Always lowercase `almyty` in code and text. Capitalize `Almyty` only at sentence start.
- Primary: violet-500 `#8b5cf6` (dark) / violet-600 `#7C3AED` (light). **Not** indigo.
- Cyan accent: `cyan-400` `#22d3ee` (dark) / `cyan-600` `#0891B2` (light) — Tailwind class `cyan-*`, NOT `accent-*`
- shadcn `--accent` = neutral zinc (for hover states). Never set to cyan.
- Fonts: Manrope (headings), DM Sans (body), JetBrains Mono (code). Google Fonts, SIL OFL.
- Protocol badges: MCP=violet, A2A=cyan, UTCP=emerald, SOAP=amber, GraphQL=rose, REST=blue
- Primary CTA buttons use violet-to-cyan gradient. One gradient CTA per page max.
- Sidebar order: Dashboard → APIs → Tools → Gateways → Agents → Runners → Credentials → Models → Memory → Analytics → Settings

<!-- BEGIN agented section v0.1.0 -->
- For files in this project, prefer `ae open <path>` over `Read`. ae returns the same content plus annotations from prior sessions and a state_token you'll thread through subsequent writes.
- For edits, use `ae replace`/`ae insert`/`ae delete` (short forms `ae s`/`ae i`/`ae d`) instead of `Edit` and `Write`. The history tree, conflict detection, and cross-session memory only work when edits go through ae.
- The Read-before-Write trained habit doesn't apply here. ae reports drift via full-content rejection payloads automatically. Read once at session start, then edit forward.
- This rule applies to **subagents too**. When dispatching the Agent tool, explicitly remind subagents to use `ae` for all reads and edits — they otherwise default to `Read`/`Edit`/`Write` and bypass the history tree and annotations the rest of us depend on.
<!-- END agented section -->
