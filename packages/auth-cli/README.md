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

## Docs

https://almyty.com/docs

## License

BSL-1.1
