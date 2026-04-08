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

🔌 **Wraps any API.** SOAP behind your firewall, REST with no docs, that one endpoint nobody wants to touch.

🧠 **Agents, not just tools.** Visual builder, multi-LLM orchestration, autonomous tool calling. Run on platform or invoke via API.

🌐 **Gateways expose everything.** Tools via MCP, A2A, UTCP, Skills. Agents via OpenAI-compatible API.

⚡ **All protocols at once.** One endpoint. A and B, not A or B.

🏠 **Self-hosted.** Your infra, your data.

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

**Run** → Scheduling, webhooks, versioning, analytics, RBAC. 3,800+ tests.

## Agent Skills CLI

```bash
npx @almyty/skills install --gateway <id>
```

Works with Claude Code, Cursor, Copilot, Windsurf, and [30+ more](https://agentskills.io).

## Development

```bash
cd backend && npm run test           # 3,800+ tests
cd frontend && npx playwright test   # E2E
```

## License

BSL-1.1
