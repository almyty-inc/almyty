# apifai

> Universal API-to-AI Tool Gateway

**apifai** turns any API into AI-ready tools. Import API schemas (OpenAPI, GraphQL, SOAP, Protobuf) to auto-generate tools, or create custom tools manually (HTTP, JavaScript, LLM-powered). Serve them to any AI agent via MCP, UTCP, A2A, or [Agent Skills](https://agentskills.io).

## Quick Start

```bash
git clone https://github.com/frane/apifai.git
cd apifai
docker-compose up -d          # PostgreSQL, Redis, backend, frontend
cd frontend && npm run dev    # Dev server at http://localhost:3002
```

Backend API at `http://localhost:4000`. Health check: `curl http://localhost:4000/health`

## What It Does

```
   Any API Schema                    Any AI Agent
  ┌─────────────┐                  ┌─────────────┐
  │  OpenAPI     │                  │ Claude Code  │
  │  GraphQL     │   ┌─────────┐   │ Cursor       │
  │  SOAP/WSDL   │──>│  apifai │──>│ Copilot      │
  │  Protobuf    │   └─────────┘   │ Any MCP/A2A  │
  │  Manual      │                  │   client     │
  └─────────────┘                  └─────────────┘
```

1. **Import APIs** — Point at any OpenAPI, GraphQL, SOAP, or Protobuf schema URL
2. **Auto-generate tools** — Each API operation becomes an executable, validated tool
3. **Create custom tools** — Build HTTP, JavaScript, GraphQL, or LLM-powered tools manually
4. **Serve to agents** — Expose tools via MCP (JSON-RPC), UTCP (HTTP), A2A (agent-to-agent), or Agent Skills (SKILL.md)
5. **Chat with APIs** — Built-in LLM integration with agentic tool calling

## Install Skills into Your Agent

```bash
npx @apifai/skills login
npx @apifai/skills install --gateway <id>    # One-time install
npx @apifai/skills watch --gateway <id>      # Auto-sync daemon
```

Supports 30+ agents: Claude Code, Cursor, GitHub Copilot, Windsurf, Codex, Gemini CLI, Cline, Roo Code, OpenHands, Goose, and more. Compatible with the [Agent Skills](https://agentskills.io) open standard.

## Tool Types

| Type | Description |
|------|-------------|
| **API (auto-generated)** | Imported from OpenAPI/GraphQL/SOAP/Protobuf schemas |
| **HTTP** | Custom HTTP endpoint with method, URL, headers, body |
| **JavaScript** | Custom JS code executed in a sandboxed environment (isolated-vm) |
| **GraphQL** | Custom GraphQL query/mutation against any endpoint |
| **LLM** | Prompt template executed against a configured LLM provider |

## Gateway Protocols

| Protocol | Use Case |
|----------|----------|
| **MCP** | JSON-RPC 2.0 for Claude, Cursor, and MCP-compatible clients |
| **UTCP** | HTTP REST API for universal tool access |
| **A2A** | Google's Agent-to-Agent protocol |
| **Skills** | SKILL.md files for Agent Skills-compatible agents |

## Tech Stack

**Backend**: NestJS, TypeScript, TypeORM, PostgreSQL, Redis, BullMQ
**Frontend**: React, Vite, shadcn/ui, Tailwind CSS, Zustand, TanStack Query
**Infrastructure**: Docker, Kubernetes (Kustomize), GitHub Actions CI/CD

## Development

```bash
# Backend tests (3,000+ tests)
cd backend && npm run test

# E2E tests (Playwright)
cd frontend && npx playwright test

# Production Docker builds
docker build --target production -t apifai-api ./backend
docker build --target production -t apifai-frontend ./frontend
```

## Documentation

- `docs/architecture.md` — System architecture
- `docs/schema-design.md` — Database schema
- `docs/implementation-plan.md` — Implementation details

## License

BSL-1.1
