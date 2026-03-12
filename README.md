# apifai

> Universal API-to-AI Tool Gateway

**apifai** parses any API schema (OpenAPI, GraphQL, SOAP, Protobuf), auto-generates AI-ready tools, and serves them via MCP, UTCP, A2A, or Agent Skills — so any AI agent can use any API.

## Quick Start

```bash
git clone https://github.com/frane/apifai.git
cd apifai
docker-compose up -d          # PostgreSQL, Redis, backend, frontend
cd frontend && npm run dev    # Dev server at http://localhost:3002
```

Backend API runs at `http://localhost:4000`. Check health: `curl http://localhost:4000/health`

## What It Does

1. **Import APIs** — Point at any OpenAPI, GraphQL, SOAP, or Protobuf schema
2. **Auto-generate tools** — Each API operation becomes an executable, validated tool
3. **Serve to agents** — Expose tools via MCP (JSON-RPC), UTCP (HTTP), A2A (agent-to-agent), or Skills (SKILL.md files)
4. **Chat with your APIs** — Built-in LLM integration with agentic tool calling (OpenAI, Anthropic, etc.)

## Architecture

```
Frontend (React + shadcn/ui)         http://localhost:3002
        |
Backend (NestJS + TypeScript)        http://localhost:4000
        |
+-------+-----------+
|       |           |
MCP    UTCP        A2A                Protocol Endpoints
|       |           |
+-------+-----------+
        |
Schema Parsers: OpenAPI, GraphQL, SOAP, Protobuf
        |
PostgreSQL 16 + Redis 7 + BullMQ
```

**Backend**: NestJS, TypeORM, 15 modules, 24 entities, 3,003 tests
**Frontend**: React 18, Vite, shadcn/ui, Zustand, TanStack Query
**Infrastructure**: Docker, Kubernetes (Kustomize), GitHub Actions CI/CD

## Development

```bash
# Run backend tests
cd backend && npm run test

# Run E2E tests (Playwright)
cd frontend && E2E_BASE_URL=http://localhost:3002 npx playwright test

# Build for production
docker build --target production -t apifai-api ./backend
docker build --target production -t apifai-frontend ./frontend
```

## Documentation

See `docs/` for architecture, database schema, and implementation details.

## License

BSL-1.1
