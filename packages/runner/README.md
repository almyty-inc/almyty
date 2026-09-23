# @almyty/runner

A long-running CLI daemon that lets almyty agents run commands on a machine you
control — your laptop, a build box, a GPU host, a server in your own network.
Execution happens on that machine, but command results and requested output
are sent back to almyty and may become agent/model context. Do not print secrets
or return sensitive file contents unless you intend to share them.
One common use is orchestrating a CLI coding agent
(Claude Code, Codex, Gemini, aider, …) against your codebase in one coherent
workspace, but nothing about the runner is specific to coding agents.

## Install

Install once, then call the installed binaries. The runner is a daemon you
start, restart, query and stop on that machine, so it is a pinned global
install rather than whatever `npx` resolves on each start.

```
npm i -g @almyty/runner @almyty/auth
almyty-auth login                      # once per machine
almyty-runner start --name my-laptop   # add --org <org-id> if you belong to several orgs
# in another terminal:
almyty-runner status
```

Stop with `almyty-runner stop` or ctrl-c in the daemon's terminal.

Or use the UI: log into your almyty account and head to **Runners → Start a
runner**. The page creates the runner (name, labels, and who can see it:
Private, Team or Org-wide), prints the exact start command, and waits for the
daemon to come online before opening the runner. From that page you can go
back and change anything, or cancel, which deletes the runner again.

## What identifies and authorises a runner

Your almyty login on that machine, not the name. `almyty-runner start` sends
the token `almyty-auth login` stored in `~/.almyty/credentials.json` (or
`ALMYTY_TOKEN`); the backend attaches the daemon to the runner of that user in
that organization. The name is a label, unique within the organization:

- Someone who knows the name cannot connect to your runner. Their daemon
  carries their login, so it is refused (the name is already used in the org)
  rather than attached to yours.
- Restarting with the same name from a machine logged in as you replaces the
  previous connection of your runner; that is how a rebuilt machine takes over.
- `--org` only picks among organizations you belong to; any other is refused.
- The daemon's live session is bound to your user as well: another member of
  the organization cannot attach a session to your runner by its id.

Who else can *use* the runner is its visibility: **Private** (the default:
you only, not even org admins), **Team**, or **Org-wide**. It is enforced on
the server when runners are listed and fetched, when work is dispatched, and on
the tools a runner publishes.

## What that command lets almyty do to your machine

Read this before you run it on a machine you care about. The daemon prints the
same summary as its third line at boot.

Out of the box, a runner uses **host isolation**: commands your agents dispatch
run as the user who started the daemon, on that machine, with that user's
files and access. There is no container and no sandbox — this build does not
implement one, and the default says so rather than implying protection it
cannot give. What *is* on by default is `installBlocked`, which refuses
`npm install`, `pip install`, `brew install` and friends, because that guard is
a pattern match on the command rather than a sandbox claim.

To narrow it, put any of these in `~/.almyty/config.json` (see **Config**):

- `allowedCwdRoots` — a list of directories commands may run in. Paths are
  canonicalized through `realpath`, so a symlink or `..` cannot escape. Empty
  means no restriction, which is the default.
- `denyPatterns` — regexes matched against the whole command line; a match is
  refused. An invalid regex falls back to a literal substring match, so a typo
  denies rather than silently allowing.
- `installBlocked` — on by default; set it to `false` only if your agents need
  to install packages.
- `maxConcurrent` — how many commands may run at once (default 4).

Two settings are accepted but not yet implementable, and the runner **refuses
every command** rather than pretending otherwise if you set either:

- `defaultIsolation: "container"` — no container runtime is wired into this
  build.
- `networkBlocked: true` — cannot be enforced under host isolation.

Both cases are reported at boot, not per command, so a runner you have
deliberately locked down does not look healthy while denying everything.

Beyond that, the backend can only *constrain* a runner further at registration
time — lower limits, smaller path allowlists, more deny patterns. It can never
escalate what your local config allows.

## What the runner does

The runner exposes a method surface over a persistent connection to almyty, and runs the actual work on your machine, scoped to a workspace:

- `process.*` — `spawn`, `write`, `close_input`, `read`, `signal`, `wait`, `wait_for_idle`, `list`
- `runner.info` — capabilities and status
- `agent.*` — `spawn`, `list`, `status` for almyty agent processes
- `coding.*` — `start`, `input`, `list`, `status`, `stop` for coding-CLI sessions

The generic `process.*` layer has no tool-specific knowledge — there is no `claude_code.run` or `codex.run`. The `coding.*` layer adds a thin registry of coding CLIs (Claude Code, Codex, Gemini, Cursor, opencode, Crush, Copilot, Grok, aider) so agents can drive them without knowing each tool's invocation and prompt quirks.

## Config

JSON, layered lowest precedence first:

1. Built-in defaults (host isolation, network allowed, installs blocked)
2. `~/.almyty/config.json` (global)
3. `./.almyty/config.json` (project-local)
4. Environment variables (`ALMYTY_URL`, `ALMYTY_TOKEN`, `ALMYTY_RUNNER_NAME`, `ALMYTY_RUNNER_ISOLATION`)
5. CLI flags (`--name`, `--org`, `--label`, `--config`, `--url`)
6. Backend overrides (constrain-only; never escalate)

A `~/.almyty/config.json` that keeps work inside one tree — the shape worth
copying if you want more than the defaults:

```json
{
  "name": "my-laptop",
  "labels": { "env": "dev", "os": "macos" },
  "config": {
    "defaultIsolation": "host",
    "maxConcurrent": 4,
    "allowedCwdRoots": ["/Users/you/workspace"],
    "denyPatterns": ["rm\\s+-rf\\s+/"],
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

- Website: https://almyty.com
- Docs: https://docs.almyty.com
- Source: https://github.com/almyty-inc/almyty

This CLI is part of the `@almyty/*` suite (versioned together at 1.x) and works with the almyty platform 0.1 and later.

Apache-2.0 © Almyty Inc.
