# @almyty/cli

Umbrella CLI for almyty. One install, every command.

## Quick start

```bash
$ npm install -g @almyty/cli
$ almyty login
$ almyty agents list
```

## Commands

| Command | Delegates to | Description |
|---------|-------------|-------------|
| `almyty login` | `@almyty/auth` | Browser-based login |
| `almyty logout` | `@almyty/auth` | Remove stored credentials |
| `almyty whoami` | `@almyty/auth` | Show current identity |
| `almyty agents <cmd>` | `@almyty/agents` | List, run, inspect agents |
| `almyty chat [org/slug]` | `@almyty/chat` | Interactive chat REPL |
| `almyty skills <cmd>` | `@almyty/skills` | Install and manage skills |
| `almyty mcp <args>` | `@almyty/mcp-server` | Start MCP server |

## Standalone packages

Every subcommand is also available as a standalone package via `npx`:

```bash
$ npx @almyty/agents list
$ npx @almyty/chat myorg/my-bot
$ npx @almyty/skills install @org/gateway
```

All packages share the same credentials file (`~/.almyty/credentials.json`), so logging in once works everywhere.

## About almyty

almyty is the full-stack platform for AI agents, agnostic by design: any LLM, any
API turned into tools, served over MCP, A2A, UTCP, and Agent Skills. Open source,
no lock-in.

- Website — https://almyty.com
- Docs — https://docs.almyty.com
- Source — https://github.com/almyty-inc/almyty

Apache-2.0 © Almyty Inc.
