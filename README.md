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

Point it at an API schema — OpenAPI, GraphQL, SOAP, Protobuf. Each operation becomes a tool. Write custom tools in JavaScript if the API doesn't have a schema, or if you need something that doesn't exist yet.

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

## Skills CLI

Install tools as [Agent Skills](https://agentskills.io) into your coding agent:

```bash
npx @almyty/skills install @acme/petstore
```

Works with Claude Code, Cursor, Copilot, Windsurf, and [30+ more](https://docs.almyty.com/cli/skills).

## CLI tools

```bash
npx @almyty/auth login                    # authenticate
npx @almyty/skills install @org/gateway   # install skills
npx @almyty/agents list                   # list agents
npx @almyty/chat my-agent                 # interactive agent REPL
```

See the [CLI docs](https://docs.almyty.com/cli/authentication) for the full reference.

## Development

```bash
cd backend && npm run test           # unit + integration
cd frontend && npm test -- --run     # vitest
cd frontend && npx playwright test   # E2E
```

## License

BSL-1.1
