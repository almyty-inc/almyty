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

## Docs

https://almyty.com/docs

## License

BSL-1.1
