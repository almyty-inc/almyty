# @almyty/chat

Interactive chat REPL for almyty agents, and the terminal client the
`/apps` **tui** build target compiles. Built with
[ink](https://github.com/vadimdemedes/ink) (React for CLI).

## Quick start

```bash
$ npx @almyty/auth login
$ npx @almyty/chat acme/support-bot
```

## Usage

```
almyty chat [<org>/<agent-slug>] [options]
```

With no agent reference it lists the agents you can reach and asks. A
bare slug uses the organization on your credentials.

### Options

| Option | What it does |
| --- | --- |
| `-m, --message <text>` | Ask one question, print the answer, exit. |
| `--stdin` | Read the question from stdin, for pipes. |
| `--resume <id>` | Continue a previous conversation. |
| `--json` | One JSON object per answer. Implies non-interactive. |
| `--no-stream` | Wait for the whole answer instead of streaming it. |
| `--no-color` | Never colour the output. `NO_COLOR` is honoured too. |
| `--max-steps <n>` | Autonomous runs: cap the number of steps. |
| `--max-cost-cents <n>` | Autonomous runs: cap the spend, in cents. |
| `-h, --help` | Show the help. |
| `-v, --version` | Print the version. |

### Slash commands

| Command | What it does |
| --- | --- |
| `/agents` | browse and switch agents |
| `/model` | show the model and routing policy in use |
| `/tools` | show available tools |
| `/cost` | show tokens and spend for this session |
| `/trace` | show the last run's steps |
| `/resume` | print the command that resumes this conversation |
| `/new` | start a fresh conversation with the same agent |
| `/runners` | list your runners + coding CLIs |
| `/code <task>` | run a coding task on a runner |
| `/code-stop` | stop the active coding session |
| `/esc` | leave coding mode (the session keeps running) |
| `/help` | show commands |
| `/clear` | clear the transcript on screen |
| `/quit` | exit |

Commands take unique prefixes and aliases: `/q` for `/quit`, `/sw` for
`/agents`, `/c` for `/clear`, `/r` for `/runners`. Tab completes.

`/clear` only clears what is on screen — the agent still has the
conversation. `/new` is the one that forgets.

`/runners` and `/code` dispatch coding tasks to a machine connected via
[`@almyty/runner`](https://www.npmjs.com/package/@almyty/runner).

### Keys

| Key | What it does |
| --- | --- |
| `Ctrl-C` | Cancel the running answer, server-side too. Again to exit. |
| `Ctrl-D` | Exit. |
| `Enter` | Send. End a line with `\` to keep typing on the next one. |
| `↑` / `↓` | Walk your input history, across sessions. |
| `Tab` | Complete a slash command. |

## Non-interactive use

```bash
# one question, one answer
almyty chat acme/support-bot -m "what is our refund window?"

# piped in
echo "summarise today's errors" | almyty chat acme/ops --stdin

# machine-readable, with the model, the cost and the ids to resume
almyty chat acme/ops -m "check the deploy" --json | jq -r .output
```

The answer goes to stdout and the attribution line to stderr, so a pipe
stays clean. The exit code follows the table every almyty CLI shares:

| Code | Meaning |
| --- | --- |
| 0 | success |
| 1 | unexpected error |
| 2 | usage error (bad flags, unknown command) |
| 3 | not authenticated — run `npx @almyty/auth login` |
| 4 | not found (no such agent) |
| 5 | the run ran and failed |

So `almyty chat deploy-check -m "ok to ship?" && ./ship.sh` does not
ship on a failed answer, and `|| case $? in 3) ... ;; 5) ... ;; esac`
can tell a missing login from a failed run.

`--json` prints one object:

```json
{
  "status": "completed",
  "output": "...",
  "agent": { "id": "...", "name": "Ops", "slug": "ops", "mode": "autonomous" },
  "model": "claude-sonnet-4",
  "routing": { "model": "claude-sonnet-4", "rationale": "cheapest", "attempt": 1 },
  "usage": { "cost": 0.0042, "tokens": 1284, "steps": 3 },
  "runId": "...",
  "conversationId": "..."
}
```

## What you see while it runs

- **Tokens as they arrive.** Autonomous runs stream over SSE and the
  answer is drawn as it is generated, not once the run has finished.
- **Tool calls, as they happen.** Each tool is announced when it starts
  and marked ok or failed with its duration when it returns.
- **Pipeline nodes.** A workflow agent's graph is streamed node by node,
  so a multi-node run is not a silent spinner.
- **Who answered and what it cost.** Every turn ends with the answering
  model, the tokens and the spend; `/cost` totals the session.
- **A cancel that means it.** `Ctrl-C` cancels the run on the server
  rather than killing the client and leaving the run spending money.

## Features

- **Gateway routing** — agents addressed as `<org>/<agent-slug>`
- **Resume conversations** — `--resume <conversation-id>` picks up where
  you left off; `/resume` and `/quit` print the command
- **Arrow-key agent picker** — run without arguments to browse and select
- **Slash commands** — tab autocomplete with fuzzy prefix matching, and
  a command palette you can arrow through
- **Input history** — kept in `~/.almyty/chat-history`, so up-arrow
  works in a fresh session and survives `/clear`
- **Markdown rendering** — bold, inline code, code blocks, lists, headers
- **Actionable errors** — a draft agent, a retired model, a spend cap and
  an unreachable API each say what happened and what to do about it
- **Bounded to your terminal** — the transcript is drawn to fit, down to
  a 40-column window, and redrawn on resize

### Not there yet

- The prompt is one line. A paragraph goes in with a trailing `\` per
  line; there is no in-place multi-line editor, and no scrollback
  keybinding for the transcript above the window.
- Only the tool-calling step of an autonomous run records which model
  answered, so a single-step reply shows the cost without the model.

## Authentication

Requires `npx @almyty/auth login` first. Reads credentials from
`~/.almyty/credentials.json`.

| Variable | What it does |
| --- | --- |
| `ALMYTY_TOKEN` | Token override, instead of the credentials file. |
| `ALMYTY_URL` | API URL override. |
| `ALMYTY_AGENT` | Default agent reference, used when none is given. |
| `ALMYTY_APP_URL` | Dashboard URL used in error messages. |
| `ALMYTY_CHAT_HISTORY` | Input history file, instead of the default. |
| `NO_COLOR` | Set to anything to disable colour. |

## Development

```bash
npm run dev        # tsx src/index.tsx
npm test           # vitest
npm run typecheck  # tsc --noEmit
npm run build      # tsc, then chmod +x dist/index.js
```

## About almyty

almyty is the full-stack platform for AI agents, agnostic by design: any LLM, any
API turned into tools, served over MCP, A2A, UTCP, and Agent Skills. Open source,
no lock-in.

- Website: https://almyty.com
- Docs: https://docs.almyty.com
- Source: https://github.com/almyty-inc/almyty

This CLI is part of the `@almyty/*` suite (versioned together at 1.x) and works with the almyty platform 0.1 and later.

Apache-2.0 © Almyty Inc.
