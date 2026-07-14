<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/almyty-logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/brand/almyty-logo-light.svg">
    <img alt="almyty" src="docs/brand/almyty-logo-dark.svg" width="240">
  </picture>
</p>

<p align="center">
  <strong>APIs to tools to agents. One platform, every protocol.</strong>
</p>

<p align="center">
  <a href="https://docs.almyty.com">Docs</a> &middot;
  <a href="https://docs.almyty.com/cli/skills">Skills CLI</a> &middot;
  <a href="https://docs.almyty.com/agents">Agents</a> &middot;
  <a href="https://docs.almyty.com/self-hosting">Self-hosting</a>
</p>

---

In university I learned about service-oriented architecture. Services discovering each other, understanding what they do, composing themselves. I loved the idea but kept wondering how that's supposed to work when computers don't actually understand anything.

Twenty years of better APIs, better protocols, better tooling. Computers still didn't get it. Then LLMs happened and that thing I'd been wondering about since university just... works. But we're sitting on decades of messy SOAP, REST, gRPC, and now five new agent protocols that don't talk to each other. Every tool makes you pick one. I wanted all of them.

## What almyty does

Point it at an API schema — OpenAPI, GraphQL, SOAP, Protobuf — and each operation becomes a tool. Or point it at an npm package (`pg`, `stripe`, `@aws-sdk/*`, etc.) and almyty generates tools from the SDK surface automatically. No code needed for either path. When you do need custom logic, write sandboxed JavaScript with full npm access — runs in a Node 24 worker thread with filesystem, process, and network restrictions enforced.

Build agents with a visual pipeline builder. Chain LLM calls, tool calls, conditions, loops, parallel fan-out, sub-agents. Or skip the pipeline and run autonomous agents that figure out the steps themselves. Either way, you get scheduling, webhooks, human-in-the-loop, and an OpenAI-compatible chat API.

Expose everything through gateways. Tools and agents are served over [MCP](https://docs.almyty.com/gateways/mcp), [A2A](https://docs.almyty.com/gateways/a2a), [UTCP](https://docs.almyty.com/gateways/utcp), [Agent Skills](https://docs.almyty.com/gateways/skills), and the [OpenAI-compatible API](https://docs.almyty.com/api-reference/openai-compatible) — from a single endpoint per gateway (`/{org}/{gateway}`). Connect agents to Slack, Discord, Telegram, email, or any webhook. You pick the protocol, almyty translates.

Self-hosted. Your infrastructure, your data.

## Quick start

```bash
git clone https://github.com/frane/almyty.git
cd almyty
docker-compose up -d
cd frontend && npm run dev    # http://localhost:3002
```

See the [self-hosting guide](https://docs.almyty.com/self-hosting) for production deployment with Kubernetes.

## How it works

```
  APIs              Tools              Agents             Protocols
 +----------+     +----------+     +--------------+    +-----------+
 | OpenAPI  |     | Auto-gen |     | Visual       |    | MCP       |
 | GraphQL  |---->| HTTP     |---->| pipeline     |--->| A2A       |
 | SOAP     |     | JS/Code  |     | builder      |    | UTCP      |
 | Protobuf |     | GraphQL  |     |              |    | OpenAI API|
 |          |     | LLM      |     | Autonomous   |    | Skills    |
 +----------+     +----------+     +--------------+    +-----------+
```

**Import** any API schema. Each operation becomes a tool. ([docs](https://docs.almyty.com))

**Build** agents visually or let them run autonomously. 10 node types, 14 LLM providers. ([docs](https://docs.almyty.com/agents))

**Deploy** tools and agents behind gateways. One endpoint, every protocol. ([docs](https://docs.almyty.com/gateways/mcp))

## CLI

One install, one login, every CLI works:

```bash
npm i -g @almyty/cli
almyty login                              # one-time browser login
```

Or invoke any individual CLI directly via `npx`:

```bash
almyty agents list                        # list agents in your org
almyty chat my-agent                      # interactive REPL with an agent
almyty skills install @acme/petstore      # install tools as Agent Skills into Claude Code, Cursor, etc.
almyty mcp                                # run almyty as an MCP server proxy
almyty runner start --name laptop         # register this machine as a runner
```

Each subcommand maps to a standalone npm package — `@almyty/auth`, `@almyty/agents`, `@almyty/chat`, `@almyty/skills`, `@almyty/mcp-server`, `@almyty/runner` — and the umbrella delegates to whichever you call. See the [CLI docs](https://docs.almyty.com/cli/authentication) for the full reference.

### Skills

Install almyty tools as [Agent Skills](https://agentskills.io) into 30+ coding agents (Claude Code, Cursor, Copilot, Windsurf, …):

```bash
npx @almyty/skills install @acme/petstore
```

### MCP

Almyty serves every tool and agent as MCP at `/{org}/{gateway}` (Streamable HTTP). Point any MCP client at the URL and the gateway's tools are available. The `@almyty/mcp-server` CLI also runs almyty as a local MCP proxy if your client only speaks stdio. ([docs](https://docs.almyty.com/gateways/mcp))

### Runners

A runner is a long-running daemon that registers your machine with almyty and executes process / shell / file ops on it, scoped to a workspace. Tools published by the runner appear in the catalog automatically; agents call them like any other tool, dispatch flows over a persistent Streamable HTTP connection. The wedge: one agent workflow orchestrating any CLI coding agent (Claude Code, Codex, gemini, aider) in one coherent session.

```bash
npx @almyty/runner start --name my-laptop
```

Or open `/runners/new` in the UI for a guided setup. See [docs/runner.md](docs/runner.md) for architecture and [docs/runner-demo.md](docs/runner-demo.md) for an end-to-end walkthrough.

## Development

```bash
cd backend && npm run test           # unit + integration
cd frontend && npm test -- --run     # vitest
cd frontend && npx playwright test   # E2E
```

## Compliance

almyty ships the operational pieces the EU AI Act asks deployers for: per-channel AI disclosure (Art. 50), human-in-the-loop approvals (Art. 14), run/audit logging (Art. 12), and a per-agent technical-documentation export (Annex IV). The full mapping — including GDPR, CRA, and the enterprise-questionnaire regimes — lives on the docs site under **Compliance**. Vulnerability reporting: see [SECURITY.md](./SECURITY.md).

## License

Apache-2.0 for the open-source core; everything under `backend/ee/` is commercial (Enterprise Edition, entitlement-gated at runtime). See [LICENSING.md](./LICENSING.md).
