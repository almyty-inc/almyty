# @almyty/mcp-server

MCP server that connects AI coding agents to almyty tools and skills.

## Quick start

```bash
$ npx @almyty/auth login
$ npx @almyty/mcp-server
```

## Agent configuration

### Claude Code

```bash
$ claude mcp add almyty -- npx -y @almyty/mcp-server
```

### Cursor / Windsurf (`.cursor/mcp.json` or `.windsurf/mcp.json`)

```json
{
  "mcpServers": {
    "almyty": {
      "command": "npx",
      "args": ["-y", "@almyty/mcp-server"]
    }
  }
}
```

### VS Code Copilot (`.vscode/mcp.json`)

```json
{
  "servers": {
    "almyty": {
      "command": "npx",
      "args": ["-y", "@almyty/mcp-server"]
    }
  }
}
```

### OpenAI Codex CLI (`~/.codex/config.toml`)

```toml
[mcp_servers.almyty]
command = "npx"
args = ["-y", "@almyty/mcp-server"]
```

### Google Gemini CLI (`~/.gemini/settings.json`)

```json
{
  "mcpServers": {
    "almyty": {
      "command": "npx",
      "args": ["-y", "@almyty/mcp-server"]
    }
  }
}
```

## Modes

- **Skill-first** (default): exposes two tools — `almyty_execute` and `almyty_search` — and loads skills on demand, so the model discovers and runs tools without every schema in context.
- **Full**: registers every gateway tool individually. Set `ALMYTY_MODE=full` to enable.

Both modes also register ten management tools for building on almyty from your
assistant: `almyty_list_apis`, `almyty_create_api`, `almyty_import_schema`,
`almyty_list_gateways`, `almyty_create_gateway`, `almyty_assign_tool`,
`almyty_list_agents`, `almyty_create_agent`, `almyty_invoke_agent`, and
`almyty_add_provider`.

## Environment variables

| Variable | Description |
|----------|-------------|
| `ALMYTY_URL` | API URL (default: `https://api.almyty.com`) |
| `ALMYTY_TOKEN` | Auth token |
| `ALMYTY_GATEWAY_ID` | Scope to a specific gateway |
| `ALMYTY_MODE` | `skill-first` (default) or `full` |

## Authentication

Requires `npx @almyty/auth login` first. Reads credentials from `~/.almyty/credentials.json`.

## About almyty

almyty is the full-stack platform for AI agents, agnostic by design: any LLM, any
API turned into tools, served over MCP, A2A, UTCP, and Agent Skills. Open source,
no lock-in.

- Website: https://almyty.com
- Docs: https://docs.almyty.com
- Source: https://github.com/almyty-inc/almyty

This CLI is part of the `@almyty/*` suite (versioned together at 1.x) and works with the almyty platform 0.1 and later.

Apache-2.0 © Almyty Inc.
