<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/almyty-logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/brand/almyty-logo-light.svg">
    <img alt="almyty" src="docs/brand/almyty-logo-dark.svg" width="240">
  </picture>
</p>

<p align="center">
  <strong>The open platform for AI agents ⚡</strong><br>
  <em>APIs → Tools → Agents — one platform, every protocol</em>
</p>

<p align="center">
  <code>MCP</code> · <code>A2A</code> · <code>UTCP</code> · <code>OpenAI API</code> · <a href="https://agentskills.io">Agent Skills</a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#what-it-does">What It Does</a> ·
  <a href="#features">Features</a> ·
  <a href="docs/architecture.md">Architecture</a> ·
  <a href="https://almyty.com">Website</a>
</p>

---

**almyty** is an open platform for building, deploying, and running AI agents. Turn any API into AI-ready tools, compose multi-LLM pipelines with a visual builder, and serve everything via MCP, A2A, UTCP, or an OpenAI-compatible API. One platform from API schema to production agent.

## Quick Start

```bash
git clone https://github.com/frane/almyty.git
cd almyty
docker-compose up -d          # PostgreSQL, Redis, backend, frontend
cd frontend && npm run dev    # Dev server at http://localhost:3002
```

Backend API at `http://localhost:4000`. Health check: `curl http://localhost:4000/health`

## What It Does

```
  APIs              Tools              Agents             Protocols
 ┌──────────┐     ┌──────────┐     ┌──────────────┐    ┌───────────┐
 │ OpenAPI  │     │ Auto-gen │     │ Visual       │    │ MCP       │
 │ GraphQL  │────>│ HTTP     │────>│ Pipeline     │───>│ A2A       │
 │ SOAP     │     │ JS/Code  │     │ Builder      │    │ UTCP      │
 │ Protobuf │     │ GraphQL  │     │              │    │ OpenAI API│
 │          │     │ LLM      │     │ Multi-LLM    │    │ Skills    │
 └──────────┘     └──────────┘     └──────────────┘    └───────────┘
```

1. **Import APIs** — Point at any OpenAPI, GraphQL, SOAP, or Protobuf schema
2. **Auto-generate tools** — Each API operation becomes an executable, validated tool
3. **Create custom tools** — HTTP, JavaScript, GraphQL, or LLM-powered
4. **Build agents** — Visual drag-and-drop pipeline builder with multi-LLM orchestration
5. **Deploy everywhere** — Serve via MCP, A2A, UTCP, Agent Skills, or OpenAI-compatible API
6. **Run at scale** — Scheduling, webhooks, analytics, versioning, RBAC

## Features

### API Management
- Import schemas from URL or file upload (OpenAPI, GraphQL, SOAP, Protobuf)
- Auto-generate tools from API operations with semantic naming
- Test API connections, manage upstream credentials (encrypted at rest)
- Re-import and re-generate tools when APIs change

### Tool System
| Type | Description |
|------|-------------|
| **API (auto-generated)** | Imported from OpenAPI/GraphQL/SOAP/Protobuf schemas |
| **HTTP** | Custom HTTP endpoint with method, URL, headers, body |
| **JavaScript** | Custom JS code executed in a sandboxed environment |
| **GraphQL** | Custom GraphQL query/mutation against any endpoint |
| **LLM** | Prompt template executed against a configured LLM provider |

### Gateway Protocols
| Protocol | Use Case |
|----------|----------|
| **MCP** | JSON-RPC 2.0 — Claude Code, Cursor, Windsurf, and MCP-compatible clients |
| **A2A** | Google's Agent-to-Agent protocol with agent card discovery |
| **UTCP** | HTTP REST for universal tool access |
| **Skills** | SKILL.md files for 30+ Agent Skills-compatible agents |

Each gateway gets a unified endpoint URL (`/{org}/{gateway}`), API key authentication, tool scoping, and integration snippets for Claude Code and Cursor.

### Agent Orchestration
- **Visual pipeline builder** — drag-and-drop canvas with 9 node types (Input, Output, LLM Call, Tool Call, Condition, Transform, Merge, Parallel, Sub-Agent)
- **Multi-LLM** — parallel fan-out to multiple LLMs, sequential chains, merge strategies (first response, best of N, concatenate, consensus)
- **Agentic tool calling** — LLM nodes can autonomously call tools during execution
- **Templates** — Simple Chat, Multi-LLM Consensus, Research Agent, Tool-Augmented Agent
- **Scheduling** — run agents on intervals with configurable input
- **Webhooks** — POST notification on execution completion
- **Version history** — save snapshots, rollback to any previous version
- **Undo/redo** — Ctrl+Z / Ctrl+Shift+Z in the builder
- **Import/export** — JSON pipeline files
- **OpenAI-compatible API** — `POST /v1/chat/completions` with `model: "agent:my-agent"`

### AI Models
- Connect OpenAI, Anthropic, Google, Cohere, HuggingFace, OpenRouter, or custom providers
- Per-provider model selection, test connection, usage tracking
- Agentic tool call loop with retry and exponential backoff

### Analytics
- Real-time dashboard with request logs, tool usage, gateway metrics, LLM cost tracking
- Per-agent execution history with node-by-node results
- CSV and JSON export

### Platform
- Multi-organization with RBAC (owner, admin, member)
- Dark and light themes
- Mobile responsive
- httpOnly cookie authentication
- Input sanitization on all user-facing fields

## Install Skills into Your Agent

```bash
npx @almyty/skills login
npx @almyty/skills install --gateway <id>    # One-time install
npx @almyty/skills watch --gateway <id>      # Auto-sync daemon
```

Supports 30+ agents: Claude Code, Cursor, GitHub Copilot, Windsurf, Codex, Gemini CLI, Cline, Roo Code, OpenHands, Goose, and more. Compatible with the [Agent Skills](https://agentskills.io) open standard.

## Tech Stack

**Backend**: NestJS, TypeScript, TypeORM, PostgreSQL, Redis, BullMQ
**Frontend**: React, Vite, shadcn/ui, Tailwind CSS, Zustand, TanStack Query, React Flow
**Infrastructure**: Docker, Kubernetes (Kustomize), GitHub Actions CI/CD, Let's Encrypt

## Development

```bash
# Backend tests (3,400+ tests, 103 suites)
cd backend && npm run test

# Frontend tests
cd frontend && npx vitest run

# E2E tests (Playwright)
cd frontend && npx playwright test

# Production Docker builds
docker build --target production -t almyty-api ./backend
docker build --target production -t almyty-frontend ./frontend
```

## License

BSL-1.1
