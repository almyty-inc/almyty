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

- **Skill-first** (default): Exposes 2 tools (`almyty_execute` + `almyty_search`) and loads skills on demand. Keeps context small.
- **Full**: Exposes all tools individually. Set `ALMYTY_MODE=full` to enable.

## Environment variables

| Variable | Description |
|----------|-------------|
| `ALMYTY_URL` | API URL (default: `https://api.almyty.com`) |
| `ALMYTY_TOKEN` | Auth token |
| `ALMYTY_GATEWAY_ID` | Scope to a specific gateway |
| `ALMYTY_MODE` | `skill` (default) or `full` |

## Authentication

Requires `npx @almyty/auth login` first. Reads credentials from `~/.almyty/credentials.json`.

## Docs

https://almyty.com/docs

## License

BSL-1.1
