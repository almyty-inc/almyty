# @almyty/acp-server

ACP (Agent Client Protocol) server for almyty. Exposes any almyty agent over ndjson stdio, compatible with Zed, JetBrains AI, and other ACP clients.

## Quick start

```bash
$ npx @almyty/auth login
$ npx @almyty/acp-server my-agent
```

## Usage

```bash
$ npx @almyty/acp-server <agent>          # agent by name or slug
$ npx @almyty/acp-server acme/my-agent    # org/slug format
```

## Editor integration

### Zed

Add to your Zed settings:

```json
{
  "agent_servers": {
    "almyty": {
      "command": "npx",
      "args": ["-y", "@almyty/acp-server", "my-agent"]
    }
  }
}
```

### JetBrains

Configure as an external ACP agent with command `npx -y @almyty/acp-server <agent>`.

## Environment variables

| Variable | Description |
|----------|-------------|
| `ALMYTY_URL` | Backend URL (default: `https://api.almyty.com`) |
| `ALMYTY_TOKEN` | API key (or auto-read from `~/.almyty/credentials.json`) |

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
