# @almyty/chat

Interactive chat REPL for almyty agents. Supports both workflow and autonomous agent modes.

## Quick start

```bash
$ npx @almyty/auth login
$ npx @almyty/chat
$ npx @almyty/chat my-research-bot
```

## Usage

Run without arguments to pick an agent from an interactive menu, or pass a name or ID to connect directly.

```bash
$ npx @almyty/chat              # interactive agent picker
$ npx @almyty/chat <name|id>    # connect to a specific agent
```

## REPL commands

| Command | Description |
|---------|-------------|
| `/switch <agent>` | Switch to a different agent |
| `/agents` | List agents (current one marked) |
| `/clear` | Clear the screen |
| `/help` | Show available commands |
| `/quit` | Exit the REPL |

## Authentication

Requires `npx @almyty/auth login` first. Reads credentials from `~/.almyty/credentials.json`. Override with `ALMYTY_TOKEN` and `ALMYTY_URL` environment variables.

## Docs

https://almyty.com/docs

## License

BSL-1.1
