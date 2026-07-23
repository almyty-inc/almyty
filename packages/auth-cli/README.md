# @almyty/auth

Browser-based authentication for all almyty CLIs. Credentials are stored at `~/.almyty/credentials.json` (mode 0600) and shared by every almyty package.

## Quick start

```bash
$ npx @almyty/auth login
$ npx @almyty/auth whoami
```

## Commands

| Command | Description |
|---------|-------------|
| `login` | Open browser to authenticate, mint an API key, save credentials |
| `logout` | Remove stored credentials |
| `whoami` | Show current identity (API URL, token prefix) |

## Login options

| Flag | Description |
|------|-------------|
| `--token <T>` | Skip the browser and store a token directly (useful for CI) |
| `--no-browser` | Print the login URL instead of opening the browser |
| `--frontend <url>` | Custom frontend URL |
| `--api <url>` | Custom API URL |

## Environment variables

| Variable | Description |
|----------|-------------|
| `ALMYTY_TOKEN` | Token override; takes precedence over credentials file |
| `ALMYTY_URL` | API URL override |
| `ALMYTY_FRONTEND_URL` | Frontend URL override (used when generating the login URL) |

## How it works

`login` runs entirely on your machine. It starts a loopback HTTP server, opens your browser to the almyty login page, and receives the token via POST body -- never in a URL. No password enters the CLI process.

## About almyty

almyty is the full-stack platform for AI agents, agnostic by design: any LLM, any
API turned into tools, served over MCP, A2A, UTCP, and Agent Skills. Open source,
no lock-in.

- Website: https://almyty.com
- Docs: https://docs.almyty.com
- Source: https://github.com/almyty-inc/almyty

This CLI is part of the `@almyty/*` suite (versioned together at 1.x) and works with the almyty platform 0.1 and later.

Apache-2.0 © Almyty Inc.
