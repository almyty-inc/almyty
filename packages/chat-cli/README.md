# @almyty/chat

Interactive chat REPL with [almyty](https://almyty.com) agents.

```bash
# Browser-based login (one-time setup)
npx @almyty/auth login

# Pick an agent from a menu
npx @almyty/chat

# Or jump straight in
npx @almyty/chat my-research-bot
```

Works with both **workflow** agents (each turn becomes one `invoke` call)
and **autonomous** agents (a run is started, polled, and resumed across
turns — handles `waiting_input` for human-in-the-loop).

## Slash commands inside the REPL

| Command | Description |
|---|---|
| `/switch <agent>` | Switch to a different agent without leaving the REPL |
| `/agents` | List agents in your organization (current one marked with →) |
| `/clear` | Clear the screen |
| `/help` | Show command list |
| `/quit`, `/exit` | Leave the REPL |

## Authentication

Reads credentials from `~/.almyty/credentials.json` (created by
`npx @almyty/auth login`). Override with `ALMYTY_TOKEN` and `ALMYTY_URL`
environment variables for CI.

## License

BSL-1.1
