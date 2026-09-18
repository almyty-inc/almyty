# @almyty/agents

Run, inspect and debug almyty agents from the command line.

## Quick start

```bash
$ npx @almyty/auth login
$ npx @almyty/agents list
$ npx @almyty/agents run my-agent --input '{"text": "hello"}' --watch
```

## Commands

| Command | Description |
|---------|-------------|
| `list` | Every agent in your organization, with mode and status |
| `get <name\|id>` | One agent: mode, status, model config, pipeline shape, tools |
| `run <name\|id>` | Invoke a workflow agent, or start an autonomous run |
| `runs <name\|id>` | Recent autonomous runs, newest first |
| `inspect <name\|id> <runId>` | One autonomous run in full: steps, models, cost, error |
| `executions <name\|id>` | Recent workflow executions, newest first |
| `trace <name\|id> <execId>` | Where a workflow execution's calls went, hop by hop |
| `cancel <name\|id> <runId>` | Cancel an in-flight autonomous run |

`<name|id>` accepts an agent name (case-insensitive, spaces or dashes),
a slug, or a UUID.

A **workflow** agent's history lives under `executions` and `trace`; an
**autonomous** agent's lives under `runs` and `inspect`. `get` tells you
which mode an agent is in, and `runs`/`executions` point you at the
other one when you ask the wrong pair.

## Run options

| Flag | Description |
|------|-------------|
| `--input '<json>'` | Input payload. Parsed as JSON; a plain string is passed through as-is, which is what an autonomous agent usually wants. |
| `--resume <conversation-id>` | Autonomous: continue a previous conversation |
| `--watch` | Autonomous: stream steps until the run reaches a terminal state |
| `--timeout <s>` | Autonomous `--watch`: stop waiting after this long (default `300`) |
| `--max-steps <n>` | Autonomous: step ceiling |
| `--max-cost-cents <n>` | Autonomous: cost ceiling, in cents |
| `--max-duration-ms <ms>` | Autonomous: wall-clock ceiling |
| `--steps` | Workflow: print per-node detail even when the run succeeded |
| `--json` | Print the run object and nothing else |

`run` refuses a non-active agent before calling the API and tells you to
activate it, rather than printing the 400 body.

## List options

| Flag | Applies to | Description |
|------|-----------|-------------|
| `--limit <n>` | `runs`, `executions` | Rows per page (default `20`) |
| `--page <n>` | `runs`, `executions` | Page number (default `1`) |

## Global options

| Flag | Description |
|------|-------------|
| `--json` | Machine-readable output on every command |
| `--help`, `-h` | Show help |
| `--version`, `-v` | Print the version |

Both `--flag value` and `--flag=value` are accepted, and everything
after a bare `--` is treated as a positional argument.

## What you can see about a run

A routed call stamps attribution on whatever recorded it — the step for
an autonomous run, the node result for a workflow one. The CLI surfaces
it, so a multi-model agent can be read from a terminal:

```
$ npx @almyty/agents run research-bot --input "who acquired Figma" --watch
  1. Searching for recent coverage…  [claude-sonnet-4-5 · $0.0021 · 900 in / 12 out · 1.8s]
  2. llm_call → tools: web_search  [claude-sonnet-4-5 · $0.0009 · 1.2s]
  3. Adobe's offer was abandoned in December 2023.  [gpt-5-mini · attempt 2 · primary rate limited · $0.0004]

Run completed · answered by claude-sonnet-4-5, gpt-5-mini · $0.0034 · 5,120 tokens · 4.2s
```

A call with a pinned provider leaves no attribution, and the CLI prints
none rather than inventing a model name.

`trace` goes further, printing the hops the backend recorded: what the
routing policy chose, what it passed over, what the provider served, and
what each hop cost. A hop whose cost is not ours to know prints as
`cost opaque`, never as `$0`.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | success |
| `1` | unexpected error |
| `2` | usage error (bad flags, unknown command, missing argument) |
| `3` | not authenticated — run `npx @almyty/auth login` |
| `4` | no such agent, run, or execution |
| `5` | the run finished in a non-success state |

`5` is the one that matters in CI. The invoke endpoint answers `200`
with `status: "failed"`, and `--watch` returns on any terminal status,
so a failed run has to be turned into a non-zero exit deliberately:

```bash
npx @almyty/agents run deploy-check --watch && ./ship.sh
```

## Environment variables

| Variable | Description |
|----------|-------------|
| `ALMYTY_TOKEN` | Auth token override |
| `ALMYTY_URL` | API URL override |
| `NO_COLOR` | Honoured; this CLI emits no ANSI colour anyway |

## Authentication

Run `npx @almyty/auth login` once. Credentials come from
`~/.almyty/credentials.json`, or from `ALMYTY_TOKEN`. With neither, every
command prints the login instruction and exits `3`.

## About almyty

almyty is the full-stack platform for AI agents, agnostic by design: any LLM, any
API turned into tools, served over MCP, A2A, UTCP, and Agent Skills. Open source,
no lock-in.

- Website: https://almyty.com
- Docs: https://docs.almyty.com
- Source: https://github.com/almyty-inc/almyty

This CLI is part of the `@almyty/*` suite (versioned together at 1.x) and works with the almyty platform 0.1 and later.

Apache-2.0 © Almyty Inc.
