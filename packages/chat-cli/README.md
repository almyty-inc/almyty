# @almyty/chat

Interactive chat REPL for almyty agents. Built with [ink](https://github.com/vadimdemedes/ink) (React for CLI).

## Quick start

```bash
$ npx @almyty/auth login
$ npx @almyty/chat acme/support-bot
```

## Usage

```
Usage:
  npx @almyty/chat <org>/<agent-slug>
  npx @almyty/chat <org>/<agent-slug> --resume <conversation-id>
  npx @almyty/chat                    # interactive agent picker

Commands:
  /agents   browse and switch agents
  /tools    show available tools
  /help     show commands
  /clear    clear conversation
  /quit     exit (shows resume command)
```

## Features

- **Gateway routing** -- agents addressed as `<org>/<agent-slug>`
- **Resume conversations** -- `--resume <conversation-id>` picks up where you left off; `/quit` prints the resume command
- **Arrow-key agent picker** -- run without arguments to browse and select
- **Slash commands** -- tab autocomplete with fuzzy prefix matching
- **Command palette** -- arrow-key navigation through matching commands
- **Input history** -- up/down arrows cycle through previous messages (derived from conversation, including resumed history)
- **SSE streaming** -- real-time tool calls and agent responses via server-sent events
- **Markdown rendering** -- bold, inline code, code blocks, lists, headers

## Authentication

Requires `npx @almyty/auth login` first. Reads credentials from `~/.almyty/credentials.json`. Override with `ALMYTY_TOKEN` and `ALMYTY_URL` environment variables.

## Docs

https://almyty.com/docs

## License

BSL-1.1
