# @apifai/mcp-server

MCP skill & tool injector for [apifai](https://github.com/your-org/apifai) — the universal API-to-AI tool gateway.

Turn **any API** (OpenAPI, GraphQL, SOAP, Protobuf) into AI tools and skills, automatically injected into your LLM via the Model Context Protocol.

## What it does

1. Connects to your apifai backend
2. Fetches auto-generated **tools** (callable functions) and **skills** (procedural knowledge)
3. Injects them into your LLM via MCP stdio transport

**Tools** = callable functions the LLM can execute
**Skills** = procedural knowledge that teaches the LLM *how* and *when* to use the tools

## Quick Start

```bash
# Set your apifai backend URL and token
export APIFAI_URL=http://localhost:4000
export APIFAI_TOKEN=your-jwt-token

# Run as MCP server
npx @apifai/mcp-server
```

Or use the interactive login:

```bash
npx @apifai/mcp-server login
```

## Configuration

### Claude Code

```bash
claude mcp add apifai -- npx -y @apifai/mcp-server
```

Or in `.mcp.json`:

```json
{
  "mcpServers": {
    "apifai": {
      "command": "npx",
      "args": ["-y", "@apifai/mcp-server"],
      "env": {
        "APIFAI_URL": "http://localhost:4000",
        "APIFAI_TOKEN": "your-jwt-token"
      }
    }
  }
}
```

### Cursor

`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "apifai": {
      "command": "npx",
      "args": ["-y", "@apifai/mcp-server"],
      "env": {
        "APIFAI_URL": "http://localhost:4000",
        "APIFAI_TOKEN": "your-jwt-token"
      }
    }
  }
}
```

### OpenAI Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.apifai]
command = "npx"
args = ["-y", "@apifai/mcp-server"]

[mcp_servers.apifai.env]
APIFAI_URL = "http://localhost:4000"
APIFAI_TOKEN = "your-jwt-token"
```

### GitHub Copilot

`.vscode/mcp.json`:

```json
{
  "servers": {
    "apifai": {
      "command": "npx",
      "args": ["-y", "@apifai/mcp-server"],
      "env": {
        "APIFAI_URL": "http://localhost:4000",
        "APIFAI_TOKEN": "your-jwt-token"
      }
    }
  }
}
```

### Google Gemini CLI

`~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "apifai": {
      "command": "npx",
      "args": ["-y", "@apifai/mcp-server"],
      "env": {
        "APIFAI_URL": "http://localhost:4000",
        "APIFAI_TOKEN": "your-jwt-token"
      }
    }
  }
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `APIFAI_URL` | `http://localhost:4000` | apifai backend URL |
| `APIFAI_TOKEN` | — | JWT Bearer token |
| `APIFAI_GATEWAY_ID` | — | Scope to a specific gateway |
| `APIFAI_MODE` | `both` | `tools`, `skills`, or `both` |

## Authentication

Three methods, in priority order:

1. **Environment variable**: Set `APIFAI_TOKEN`
2. **Stored credentials**: Run `npx @apifai/mcp-server login` once
3. **OAuth** (planned): Browser-based OAuth flow to apifai

## How it works

```
Your LLM (Claude, Cursor, Copilot, Codex, Gemini)
    ↕ MCP (stdio)
@apifai/mcp-server (this package)
    ↕ HTTP/JSON-RPC
apifai backend
    ↕ HTTP/GraphQL/SOAP/gRPC
Your APIs (any format)
```

The apifai backend parses your API schemas, auto-generates tools with proper parameter schemas, and this MCP server exposes them to any LLM. Skills provide the procedural knowledge layer — not just "what parameters does this tool take" but "when should I use this tool, what steps to follow, and how to handle errors."

## License

BSL-1.1
