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
  /agents      browse and switch agents
  /tools       show available tools
  /runners     list your runners + coding CLIs
  /code        run a coding task on a runner
  /code-stop   stop the active coding session
  /esc         leave coding mode (session keeps running)
  /help        show commands
  /clear       clear conversation
  /quit        exit (shows resume command)
```

Slash commands accept fuzzy prefixes and aliases (e.g. `/sw` for `/agents`,
`/q` for `/quit`). `/runners` and `/code` dispatch coding tasks to a machine
connected via [`@almyty/runner`](https://www.npmjs.com/package/@almyty/runner).

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

## About almyty

almyty is the full-stack platform for AI agents, agnostic by design: any LLM, any
API turned into tools, served over MCP, A2A, UTCP, and Agent Skills. Open source,
no lock-in.

- Website: https://almyty.com
- Docs: https://docs.almyty.com
- Source: https://github.com/almyty-inc/almyty

This CLI is part of the `@almyty/*` suite (versioned together at 1.x) and works with the almyty platform 0.1 and later.

Apache-2.0 © Almyty Inc.
