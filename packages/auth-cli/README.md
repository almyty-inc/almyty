# @almyty/auth

Browser-based authentication for every almyty CLI. Credentials are
stored at `~/.almyty/credentials.json` (mode `0600`, in a `0700`
directory) and shared by `@almyty/agents`, `@almyty/chat`,
`@almyty/skills`, `@almyty/models`, `@almyty/connections`,
`@almyty/mcp-server` and `@almyty/runner`.

## Quick start

```bash
$ npx @almyty/auth login
$ npx @almyty/auth whoami
```

## Commands

| Command | Description |
|---------|-------------|
| `login` | Open the browser, authenticate, store the token |
| `logout` | Remove stored credentials |
| `whoami` | Show the stored identity and when the token expires |

## Login options

| Flag | Description |
|------|-------------|
| `--token <T>` | Skip the browser and store a token directly (useful for CI) |
| `--no-browser` | Print the login URL instead of opening a browser |
| `--frontend <url>` | Frontend origin hosting `/cli-login` (default `https://app.almyty.com`) |
| `--api <url>` | API origin to store with the token (default `https://api.almyty.com`) |

An `http://` API URL is refused for anything but loopback: the JWT
crosses that connection. A bad URL exits `2` and nothing is written.

## whoami options

| Flag | Description |
|------|-------------|
| `--verify` | Also call `GET /auth/profile` to confirm the token still works, and list the organizations it can see |
| `--json` | Machine-readable output |

`whoami` reports the token's expiry without a network call: `login`
reads the `exp` and `email` claims out of the JWT and stores them
alongside it. An expired token exits `3`, so `whoami` is a usable
precondition in a script:

```bash
npx @almyty/auth whoami --verify > /dev/null || npx @almyty/auth login
```

`whoami` never prints the token — only a first-8/last-4 preview, enough
to tell two tokens apart in a bug report.

## Global options

| Flag | Description |
|------|-------------|
| `--json` | Machine-readable output, where the command has any (`whoami`, `logout`) |
| `--help`, `-h` | Show help |
| `--version`, `-v` | Print the version |

Both `--flag value` and `--flag=value` are accepted.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | success |
| `1` | unexpected error |
| `2` | usage error (bad flags, unknown command, refused URL) |
| `3` | not authenticated, expired, or the API rejected the token |

## Environment variables

| Variable | Description |
|----------|-------------|
| `ALMYTY_TOKEN` | Token override; read instead of the credentials file |
| `ALMYTY_URL` | API URL override |
| `ALMYTY_FRONTEND_URL` | Frontend URL override (used when generating the login URL) |
| `NO_COLOR` | Honoured; this CLI emits no ANSI colour anyway |

## Files

| Path | Contents |
|------|----------|
| `~/.almyty/credentials.json` | The token, the API URL it belongs to, its expiry, the email. Mode `0600`. |
| `~/.almyty/config.json` | The API and frontend URLs `login` was pointed at, so later commands do not need the flags again. Written only after a login succeeds. |

## How it works

`login` runs entirely on your machine. It binds a server to `127.0.0.1`
on a random port, generates a 32-byte `state` nonce, and opens your
browser at `{frontend}/cli-login`. The page authenticates you and hands
the token back to the loopback server, which checks the nonce before
accepting it. The token travels in a POST body, never in a URL, so it
does not land in browser history or a proxy log. No password enters the
CLI process.

## About almyty

almyty is the full-stack platform for AI agents, agnostic by design: any LLM, any
API turned into tools, served over MCP, A2A, UTCP, and Agent Skills. Open source,
no lock-in.

- Website: https://almyty.com
- Docs: https://docs.almyty.com
- Source: https://github.com/almyty-inc/almyty

This CLI is part of the `@almyty/*` suite (versioned together at 1.x) and works with the almyty platform 0.1 and later.

Apache-2.0 © Almyty Inc.
