<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/almyty-logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/brand/almyty-logo-light.svg">
    <img alt="almyty" src="docs/brand/almyty-logo-dark.svg" width="240">
  </picture>
</p>

<p align="center">
  <strong>The open platform for AI agents ⚡</strong><br>
  APIs → Tools → Agents — one platform, every protocol
</p>

<p align="center">
  <code>MCP</code> · <code>A2A</code> · <code>UTCP</code> · <code>OpenAI API</code> · <a href="https://agentskills.io">Agent Skills</a>
</p>

---

In university I learned about service-oriented architecture. Services discovering each other, understanding what they do, composing themselves. I loved the idea but kept wondering how that's supposed to work when computers don't actually understand anything.

Twenty years of better APIs, better protocols, better tooling. Computers still didn't get it. Then LLMs happened and that thing I'd been wondering about since university just... works. But we're sitting on decades of messy SOAP, REST, gRPC, and now five new agent protocols that don't talk to each other. Every tool makes you pick one. I wanted all of them.

### Why

🔌 **Wraps any API.** OpenAPI, GraphQL, SOAP, Protobuf / gRPC. SOAP behind your firewall, REST with no docs, that one endpoint nobody wants to touch.

🧠 **Agents, not just tools.** Visual pipeline builder with 10 node types (LLM calls, tool calls, conditions, transforms, loops, parallel fan-out, sub-agents). Multi-LLM orchestration. Run on platform, trigger via webhook, schedule via cron, or invoke via OpenAI-compatible API.

🌐 **Gateways expose everything.** Tools via MCP, A2A, UTCP, Skills. Agents via OpenAI-compatible chat completions. One endpoint (`/{org}/{gateway}`), every protocol.

🔒 **Sandboxed custom tools.** Write JavaScript tool code that imports npm packages (`pg`, `mongodb`, `stripe`, `@aws-sdk/*`, etc.). Each execution runs in a Node 24 worker thread with the `--permission` flag set: filesystem read is scoped to the tool's own deps, `fs.write` / `child_process` / `worker_threads` / native addons are denied, and a per-host network egress filter refuses RFC1918 / loopback / link-local / metadata-endpoint targets.

🛡️ **Hardened multi-tenancy.** Every tenant-scoped service filters by `organizationId` at the SQL layer. Cross-tenant isolation is verified by a real-Postgres integration suite across 7 services, not just mocked assertions.

🔑 **Credentials + OAuth2.** Encrypted credential vault with per-tenant scoping. OAuth2 token refresh with SSRF-guarded token endpoint, refresh-token rotation, and concurrent-refresh debouncing.

📊 **Analytics, audit, RBAC.** Usage metrics, audit trail for sensitive actions, four-role RBAC (owner / admin / member / viewer), multi-org membership, team scoping.

🏠 **Self-hosted.** Your infra, your data. Docker Compose, Kubernetes (Kustomize overlays for dev/staging/prod), Let's Encrypt via cert-manager.

## Quick Start

```bash
git clone https://github.com/frane/almyty.git
cd almyty
docker-compose up -d
cd frontend && npm run dev    # http://localhost:3002
```

## How It Works

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

**Import** → Point at any schema. Each operation becomes a tool.

**Build** → Visual pipeline builder. LLM calls, tool calls, conditions, parallel fan-out, sub-agents.

**Deploy** → One endpoint (`/{org}/{gateway}`), all protocols.

**Run** → Scheduling, webhooks, versioning, analytics, RBAC. 4,000+ backend tests (incl. real-Postgres, real-HTTP, and real-worker-thread integration suites).

## Agent Skills CLI

```bash
npx @almyty/skills install --gateway <id>
```

Works with Claude Code, Cursor, Copilot, Windsurf, and [30+ more](https://agentskills.io).

## Development

```bash
cd backend && npm run test           # unit + mocked (4,000+ tests)
cd backend && npm run test:db        # real-Postgres integration (requires local DB)
cd frontend && npm run test          # vitest
cd frontend && npx playwright test   # E2E
```

CI runs the full suite (backend unit + DB integration + frontend vitest + typecheck) on every push and PR.

## License

BSL-1.1
