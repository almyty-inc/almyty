# @almyty/auth

Browser-based login for almyty CLIs. Stores credentials at `~/.almyty/credentials.json`
where every other almyty CLI (`@almyty/skills`, `@almyty/agents`, `@almyty/chat`,
`@almyty/mcp-server`) reads them.

## Quick start

```bash
# Browser flow (default)
npx @almyty/auth login

# Headless / paste a token directly
npx @almyty/auth login --token <T>

# Check who you are
npx @almyty/auth whoami

# Sign out
npx @almyty/auth logout
```

## How it works

`login` runs entirely on your machine — no password ever enters this CLI process.

1. Generates a 32-byte random `state` nonce.
2. Starts a tiny HTTP server on `127.0.0.1` (loopback only) on a random port.
3. Opens your browser to `https://app.almyty.com/cli-login?callback=…&state=…`.
4. The frontend page authenticates you (existing session, or normal login),
   then `POST`s `{ token, state }` back to the local callback URL.
5. The local server validates `state`, hands the token to the CLI, and shuts down.

The token is delivered in a POST body — never in a URL — so it doesn't end up
in browser history, server logs, or reverse-proxy access logs.

## Options

| Flag | Description |
|---|---|
| `--token <T>` | Skip the browser, store this token directly. Useful for CI. |
| `--frontend <url>` | Override the frontend origin (default `https://app.almyty.com`). |
| `--api <url>` | Override the API origin (default `https://api.almyty.com`). |
| `--no-browser` | Print the URL but don't auto-open the browser. |

## Environment variables

| Var | Effect |
|---|---|
| `ALMYTY_TOKEN` | Token override; takes precedence over `~/.almyty/credentials.json`. |
| `ALMYTY_URL` | API URL override. |
| `ALMYTY_FRONTEND_URL` | Frontend URL override (used when generating the login URL). |

## License

BSL-1.1
