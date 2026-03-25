# @almyty/mcp-server

Skill-first API proxy for any LLM — turns APIs into AI skills with minimal token overhead.

## The Problem with Traditional MCP

MCP dumps every tool's full JSON Schema into the LLM's context window:

```
20 tools × ~200 tokens/schema = ~4,000 tokens/turn (always in context)
400 tools = 80,000+ tokens (unusable)
```

## The Skill-First Solution

Instead of N tool schemas, inject:
1. **2 tools** (`almyty_execute` + `almyty_search`) = ~300 tokens base
2. **Skills as prompts** = loaded on-demand, only when needed

```
Token overhead: ~300 tokens (fixed) vs ~4,000+ tokens (scales with tool count)
```

Skills are compact markdown that teach the LLM **workflows** — when to use a tool, what parameters to collect, how to handle errors. The LLM loads a skill on demand, then calls `almyty_execute` with the right tool name.

## How It Works

```
LLM wants to "create a pet"
  ↓
1. Calls almyty_search("pet") → finds relevant tools
2. Loads skill-petstore prompt → learns the workflow
3. Calls almyty_execute(tool_name="addPet", parameters={...})
  ↓
almyty backend executes against the actual API
```

## Quick Start

```bash
export APIFAI_URL=http://localhost:4000
export APIFAI_TOKEN=your-jwt-token
npx @almyty/mcp-server
```

Or login interactively:
```bash
npx @almyty/mcp-server login
```

## Configuration

### Claude Code

```bash
claude mcp add almyty -- npx -y @almyty/mcp-server
```

### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "almyty": {
      "command": "npx",
      "args": ["-y", "@almyty/mcp-server"],
      "env": { "APIFAI_URL": "http://localhost:4000", "APIFAI_TOKEN": "..." }
    }
  }
}
```

### OpenAI Codex CLI (`~/.codex/config.toml`)

```toml
[mcp_servers.almyty]
command = "npx"
args = ["-y", "@almyty/mcp-server"]

[mcp_servers.almyty.env]
APIFAI_URL = "http://localhost:4000"
APIFAI_TOKEN = "your-jwt-token"
```

### GitHub Copilot (`.vscode/mcp.json`)

```json
{ "servers": { "almyty": { "command": "npx", "args": ["-y", "@almyty/mcp-server"] } } }
```

### Google Gemini CLI (`~/.gemini/settings.json`)

```json
{ "mcpServers": { "almyty": { "command": "npx", "args": ["-y", "@almyty/mcp-server"] } } }
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `APIFAI_URL` | `http://localhost:4000` | almyty backend URL |
| `APIFAI_TOKEN` | — | JWT Bearer token |
| `APIFAI_GATEWAY_ID` | — | Scope to a specific gateway |
| `APIFAI_MODE` | `skill-first` | `skill-first` or `full` |

## Modes

| Mode | Tools in context | Token overhead | How it works |
|------|-----------------|----------------|--------------|
| `skill-first` | 2 (execute + search) | ~300 tokens | Skills loaded on demand via prompts |
| `full` | All N tools | ~N×200 tokens | Traditional MCP (every schema in context) |

## Architecture

```
Your LLM (Claude, Cursor, Copilot, Codex, Gemini)
    ↕ MCP stdio (2 tools + skills as prompts)
@almyty/mcp-server
    ↕ HTTP/JSON-RPC
almyty backend (tools + skills + auth)
    ↕ HTTP/GraphQL/SOAP/gRPC
Your APIs (OpenAPI, GraphQL, SOAP, Protobuf)
```

**Auth model:**
- User → almyty: JWT token (env var or `npx @almyty/mcp-server login`)
- almyty → APIs: Managed within almyty (API keys, OAuth, etc.)

## License

BSL-1.1
