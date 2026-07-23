# @almyty/agents

List, run, and manage almyty agents from the command line.

## Quick start

```bash
$ npx @almyty/auth login
$ npx @almyty/agents list
$ npx @almyty/agents run my-agent --input '{"text": "hello"}' --watch
```

## Commands

| Command | Description |
|---------|-------------|
| `list [--json]` | List all agents in your organization |
| `get <name\|id>` | Show details for one agent |
| `run <name\|id> [options]` | Invoke a workflow or start an autonomous run |
| `runs <name\|id>` | List recent runs for an agent |
| `cancel <name\|id> <runId>` | Cancel an in-flight run |

`<name|id>` accepts an agent name (case-insensitive) or UUID.

## Run options

| Flag | Description |
|------|-------------|
| `--input '<json>'` | Input payload (object for workflow, string or object for autonomous) |
| `--resume <conversation-id>` | Resume a previous autonomous conversation |
| `--watch` | Stream steps as they arrive |
| `--json` | Print raw JSON output |
| `--max-steps <n>` | Autonomous: max steps (default 50) |
| `--max-cost-cents <n>` | Autonomous: max cost in cents (default 100) |
| `--max-duration-ms <ms>` | Autonomous: max wall time in ms (default 3600000) |

## Environment variables

| Variable | Description |
|----------|-------------|
| `ALMYTY_TOKEN` | Auth token override |
| `ALMYTY_URL` | API URL override |

## Authentication

Requires `npx @almyty/auth login` first. Reads credentials from `~/.almyty/credentials.json`.

## About almyty

almyty is the full-stack platform for AI agents, agnostic by design: any LLM, any
API turned into tools, served over MCP, A2A, UTCP, and Agent Skills. Open source,
no lock-in.

- Website — https://almyty.com
- Docs — https://docs.almyty.com
- Source — https://github.com/almyty-inc/almyty

Apache-2.0 © Almyty Inc.
