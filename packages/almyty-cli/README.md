# @almyty/cli

Umbrella CLI for almyty. One install, one login, every command.

## Quick start

```bash
$ npm install -g @almyty/cli
$ almyty                  # a short tour
$ almyty login
$ almyty agents list
```

`almyty` on its own prints a five-line tour. `almyty help` prints the
full reference, and `almyty <command> --help` prints that command's own
options — the umbrella forwards `--help` to the package it delegates to.

## Commands

| Command | Delegates to | Description |
|---------|-------------|-------------|
| `almyty login` | `@almyty/auth` | Browser-based login (writes `~/.almyty/credentials.json`) |
| `almyty logout` | `@almyty/auth` | Remove stored credentials |
| `almyty whoami` | `@almyty/auth` | Show the current identity and when it expires |
| `almyty auth <cmd>` | `@almyty/auth` | The same three, spelled out |
| `almyty agents <cmd>` | `@almyty/agents` | List, run, inspect and trace agents |
| `almyty chat [ref]` | `@almyty/chat` | Interactive chat REPL |
| `almyty skills <cmd>` | `@almyty/skills` | Install API skills into AI coding agents |
| `almyty models <cmd>` | `@almyty/models` | Models: catalog, validation, hosted models |
| `almyty connections <cmd>` | `@almyty/connections` | Connect third-party accounts, validate, grant |
| `almyty runner <cmd>` | `@almyty/runner` | Run agents on this machine as a daemon |
| `almyty mcp <args>` | `@almyty/mcp-server` | Serve your agents and tools over MCP |
| `almyty acp <args>` | `@almyty/acp-server` | Serve an agent over the Agent Client Protocol |

Handled by the umbrella itself:

| Command | Description |
|---------|-------------|
| `almyty help`, `--help` | The full command reference |
| `almyty version`, `--version` | The installed version |
| `almyty completion <shell>` | A completion script for `bash`, `zsh` or `fish` |

An unknown command exits `2` and suggests the nearest real one
(`almyty agent list` → "Did you mean `almyty agents`?").

## Shell completion

```bash
# bash — add to ~/.bashrc
eval "$(almyty completion bash)"

# zsh — add to ~/.zshrc
eval "$(almyty completion zsh)"

# fish
almyty completion fish > ~/.config/fish/completions/almyty.fish
```

## Exit codes

The same table in every almyty CLI, so `almyty <anything>` can be
scripted the same way:

| Code | Meaning |
|------|---------|
| `0` | success |
| `1` | unexpected error |
| `2` | usage error (bad flags, unknown command) |
| `3` | not authenticated — run `almyty login` |
| `4` | not found (agent, gateway, skill, or run) |
| `5` | the operation ran and failed |

```bash
almyty agents run deploy-check --watch || case $? in
  3) almyty login ;;
  5) echo "the check failed"; exit 1 ;;
esac
```

## Standalone packages

Every subcommand is also a standalone package, so the umbrella is a
convenience and not a requirement:

```bash
$ npx @almyty/auth login
$ npx @almyty/agents list
$ npx @almyty/chat myorg/my-bot
$ npx @almyty/skills install org/gateway
```

They all read the same credentials file (`~/.almyty/credentials.json`),
so logging in once works everywhere.

## Piping

Every read command takes `--json` and prints nothing but JSON on stdout.
No almyty CLI emits ANSI colour of its own, so `NO_COLOR` is honoured
and there is nothing to strip when you pipe.

## About almyty

almyty is the full-stack platform for AI agents, agnostic by design: any LLM, any
API turned into tools, served over MCP, A2A, UTCP, and Agent Skills. Open source,
no lock-in.

- Website: https://almyty.com
- Docs: https://docs.almyty.com
- Source: https://github.com/almyty-inc/almyty

This CLI is part of the `@almyty/*` suite (versioned together at 1.x) and works with the almyty platform 0.1 and later.

Apache-2.0 © Almyty Inc.
