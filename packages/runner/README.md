# @almyty/runner

A long-running CLI daemon that executes processes on a user's machine on behalf of almyty agents. Lets a workflow orchestrate any CLI coding agent (Claude Code, Codex, Gemini, aider, …) on your codebase, in one coherent workspace.

## Install

```
npx @almyty/runner start --name my-laptop
```

Three commands in three minutes:

```
npx @almyty/auth login          # if you haven't already
npx @almyty/runner start --name my-laptop --label os=macos
# in another terminal:
npx @almyty/runner status
```

Stop with `npx @almyty/runner stop` or ctrl-c in the daemon's terminal.

Or use the UI: log into your almyty account and head to **Runners → Start a runner**. The page generates the exact start command for you and waits for the daemon to come online before redirecting to the runner detail.

## What the runner does

The runner exposes a method surface over a persistent connection to almyty, and runs the actual work on your machine, scoped to a workspace:

- `process.*` — `spawn`, `write`, `close_input`, `read`, `signal`, `wait`, `wait_for_idle`, `list`
- `runner.info` — capabilities and status
- `agent.*` — `spawn`, `list`, `status` for almyty agent processes
- `coding.*` — `start`, `input`, `list`, `status`, `stop` for coding-CLI sessions

The generic `process.*` layer has no tool-specific knowledge — there is no `claude_code.run` or `codex.run`. The `coding.*` layer adds a thin registry of coding CLIs (Claude Code, Codex, Gemini, Cursor, opencode, Crush, Copilot, Grok, aider) so agents can drive them without knowing each tool's invocation and prompt quirks.

## Config

JSON, layered lowest precedence first:

1. Built-in defaults (most restrictive: container isolation, no installs, no network)
2. `~/.almyty/config.json` (global)
3. `./.almyty/config.json` (project-local)
4. Environment variables (`ALMYTY_URL`, `ALMYTY_TOKEN`, `ALMYTY_RUNNER_NAME`, `ALMYTY_RUNNER_ISOLATION`)
5. CLI flags (`--name`, `--label`, `--config`, `--url`)
6. Backend overrides (constrain-only; never escalate)

A minimal `~/.almyty/config.json`:

```json
{
  "name": "my-laptop",
  "labels": { "env": "dev", "os": "macos" },
  "config": {
    "defaultIsolation": "host",
    "maxConcurrent": 4,
    "allowedCwdRoots": ["/Users/frane/workspace"],
    "denyPatterns": [],
    "networkBlocked": false,
    "installBlocked": true
  }
}
```

## Architecture

See [docs/runner.md](../../docs/runner.md) for the load-bearing design decisions: Streamable HTTP transport, no per-tool wrappers, PTY by default, detected vs configured fields, resource scoping, and config layering.

.

## About almyty

almyty is the full-stack platform for AI agents, agnostic by design: any LLM, any
API turned into tools, served over MCP, A2A, UTCP, and Agent Skills. Open source,
no lock-in.

- Website — https://almyty.com
- Docs — https://docs.almyty.com
- Source — https://github.com/almyty-inc/almyty

Apache-2.0 © Almyty Inc.
