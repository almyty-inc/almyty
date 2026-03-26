# @almyty/mcp-server

Local MCP server that connects your AI coding agent to [almyty](https://almyty.com) tools and skills.

## Quick Start

```bash
npx @almyty/mcp-server
```

## Setup

### Claude Code

```bash
claude mcp add almyty -- npx -y @almyty/mcp-server
```

### Cursor / Windsurf (`.cursor/mcp.json`)

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

### OpenAI Codex CLI (`~/.codex/config.toml`)

```toml
[mcp_servers.almyty]
command = "npx"
args = ["-y", "@almyty/mcp-server"]
```

## How It Works

Instead of dumping every tool schema into the LLM context (thousands of tokens), this server uses a skill-first approach:

1. **2 tools** exposed to the LLM: `almyty_execute` + `almyty_search`
2. **Skills as prompts** loaded on demand when the LLM needs them
3. LLM searches for relevant tools → loads the skill → calls execute

```
Traditional MCP: 20 tools × ~200 tokens = ~4,000 tokens (always in context)
Skill-first:     2 tools + on-demand skills = ~300 tokens base
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ALMYTY_URL` | `https://api.almyty.com` | almyty API URL |
| `ALMYTY_TOKEN` | — | Auth token (or use `npx @almyty/mcp-server login`) |
| `ALMYTY_GATEWAY_ID` | — | Scope to a specific gateway |

## Authentication

```bash
# Interactive login (opens browser)
npx @almyty/mcp-server login

# Or set token directly
export ALMYTY_TOKEN=your-token
npx @almyty/mcp-server
```

## License

BSL-1.1
