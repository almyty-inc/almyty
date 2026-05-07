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

The runner exposes a small process surface (spawn, write, read, signal, wait_for_idle, wait, list, shell.exec, runner.info) over a persistent connection to almyty. Agents call those methods, scoped to a workspace, and the runner runs the actual processes on your machine. It does not bake in any tool-specific knowledge: there is no `claude_code.run` or `codex.run`. Tool intelligence lives in agent prompts; the runner is generic.

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

## License

BSL-1.1.
