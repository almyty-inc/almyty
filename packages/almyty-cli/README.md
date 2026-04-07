# @almyty/cli

Single installable CLI for almyty. Bundles `@almyty/auth`, `@almyty/agents`,
`@almyty/chat`, `@almyty/skills`, and `@almyty/mcp-server` under one binary.

```bash
npm install -g @almyty/cli

almyty login                            # browser-based login
almyty agents list                      # list your agents
almyty chat my-research-bot             # interactive REPL
almyty skills install @org/gateway      # install API skills locally
```

## Commands

| Command | Delegates to | Description |
|---|---|---|
| `almyty login` | `@almyty/auth login` | Browser-based login |
| `almyty logout` | `@almyty/auth logout` | Remove stored credentials |
| `almyty whoami` | `@almyty/auth whoami` | Show current identity |
| `almyty auth <sub>` | `@almyty/auth` | Pass-through |
| `almyty agents <sub>` | `@almyty/agents` | List, run, inspect agents |
| `almyty chat [agent]` | `@almyty/chat` | Interactive chat REPL |
| `almyty skills <sub>` | `@almyty/skills` | Install API skills into AI coding agents |
| `almyty mcp <args>` | `@almyty/mcp-server` | Run the MCP server proxy |

## Why two ways to invoke?

Each capability lives as a standalone npm package so you can use whichever
shape fits your environment:

- **Long-lived dev machine**: `npm install -g @almyty/cli` and use `almyty …`.
- **Quick one-off**: `npx @almyty/agents list` skips the install entirely.
- **CI**: drop a single `npx @almyty/<thing>` in a step without polluting
  the global namespace.

The umbrella and the standalone packages share the same on-disk credentials
file (`~/.almyty/credentials.json`), so logging in once works everywhere.

## License

BSL-1.1
