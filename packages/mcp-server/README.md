# @almyty/mcp-server

An MCP server that connects any AI coding agent to your almyty tools, skills
and agents — over stdio, with two tools in context instead of twenty.

## Quick start

```bash
npx @almyty/auth login
claude mcp add almyty -- npx -y @almyty/mcp-server
```

Or scope it to one gateway:

```bash
npx @almyty/mcp-server acme/billing
```

The positional argument is `orgSlug/gatewaySlug`; with none, the server serves
every gateway the token can see.

## Why skill-first

A traditional MCP server puts every tool's JSON Schema in the model's context
on every turn. Twenty tools is roughly 4,000 tokens you pay for whether or not
the model uses one.

This server registers **two** tools instead, roughly 300 tokens, and serves
each skill as an MCP prompt the model loads only when it needs it:

| Tool | What it does |
|---|---|
| `almyty_execute` | Run any almyty tool by name, with a parameter object |
| `almyty_search` | Find tools by keyword, so the model discovers before it calls |

The model reads a skill to learn a workflow, then calls `almyty_execute`. The
`almyty-overview` prompt is a compact index of everything available.

`almyty_search` re-reads the tool index when what it holds has gone stale
(about a minute), so a tool you add in almyty is findable without restarting
your editor.

## Modes

Set `ALMYTY_MODE`:

- **`skill-first`** (default) — the two tools above plus skills as prompts.
- **`full`** — every gateway tool registered individually, traditional MCP.
  Higher context cost. The list is read once at startup, and the client is
  notified when it arrives.

## Management tools

Both modes also register eleven tools for building on almyty from your
assistant:

| Tool | |
|---|---|
| `almyty_list_apis` | `almyty_create_api` |
| `almyty_import_schema` | `almyty_list_gateways` |
| `almyty_create_gateway` | `almyty_assign_tool` |
| `almyty_list_agents` | `almyty_create_agent` |
| `almyty_invoke_agent` | `almyty_list_providers` |
| `almyty_add_provider` | |

`almyty_add_provider` takes a **connection id**, never an API key. A key
passed as a tool argument would be written into the assistant's transcript and
the host editor's logs, so the key goes through the connections flow instead:

```bash
npx @almyty/connections connect openai
npx @almyty/connections list        # -> the id to hand the tool
```

## When almyty is not reachable

The server connects its transport before it fetches anything, so the MCP
handshake always completes: an editor never sees the server die during
startup because the API was down or the token had gone stale. Discovery then
runs, and a failure is reported on the tool call that needed it, in words that
name the fix — `run npx @almyty/auth login` for a stale token, `check
ALMYTY_URL` for an unreachable host. The management tools keep working
throughout.

Every call is bounded: 15 seconds for discovery, 120 for a tool execution.
A hung backend fails the call rather than hanging your editor.

## stdio discipline

stdout carries the MCP protocol and nothing else; every diagnostic goes to
stderr. One stray line on stdout corrupts the JSON-RPC stream and the host
loses the server with no useful error, so `--help` and `--version` are the
only things this binary ever writes to stdout, and it exits without starting a
server when you ask for either.

## Agent configuration

### Claude Code

```bash
claude mcp add almyty -- npx -y @almyty/mcp-server
```

### Cursor / Windsurf (`.cursor/mcp.json` or `~/.codeium/windsurf/mcp_config.json`)

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

## Environment variables

| Variable | Description |
|----------|-------------|
| `ALMYTY_URL` | API URL (default: `https://api.almyty.com`) |
| `ALMYTY_TOKEN` | Token; otherwise read from `~/.almyty/credentials.json` |
| `ALMYTY_GATEWAY_ID` | Gateway as `orgSlug/gatewaySlug` (alternative to the positional argument) |
| `ALMYTY_MODE` | `skill-first` (default) or `full` |

## Authentication

Run `npx @almyty/auth login` once; credentials are read from
`~/.almyty/credentials.json`. `ALMYTY_TOKEN` overrides the file. The old
`mcp-server login` / `logout` / `whoami` subcommands now point at
`@almyty/auth` and exit non-zero.

## About almyty

almyty is the platform for AI agents, agnostic by design: any LLM, any API
turned into tools, served over MCP, A2A, UTCP and Agent Skills. Open source,
no lock-in.

- Website: https://almyty.com
- Docs: https://docs.almyty.com
- Source: https://github.com/almyty-inc/almyty

This CLI is part of the `@almyty/*` suite (versioned together at 1.x) and
works with the almyty platform 0.1 and later.

Apache-2.0 © Almyty Inc.
