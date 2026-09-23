# @almyty/skills

Turn any API in your almyty gateways into a `SKILL.md` your coding agent
reads on its next session. 30 agents are recognised — Claude Code,
Codex, Cursor, Windsurf, GitHub Copilot, Gemini CLI, Amp, Cline,
Continue, Goose, Junie, Roo Code, Trae, OpenHands, OpenCode, Augment and
more — plus the universal `.agents/skills/` convention.

## Quick start

```bash
$ npx @almyty/auth login
$ npx @almyty/skills gateways
$ npx @almyty/skills install org/gateway --dry-run   # see the exact files
$ npx @almyty/skills install org/gateway
```

## Commands

| Command | Description |
|---------|-------------|
| `gateways` | Your gateways, and the ref to install each |
| `list` | Every skill available to you |
| `list org/gateway` | Skills from one gateway |
| `search <query>` | Search your gateways' skills by keyword |
| `install org/gateway` | Install every skill from a gateway |
| `install org/gateway/skill` | Install one skill |
| `installed` | Skills this CLI has installed in this directory |
| `remove` | Remove every skill this CLI installed here |
| `run org/gateway/skill [--key value]` | Execute one skill and print its result |
| `daemon [--interval 60]` | Re-sync every skill on a timer |
| `watch org/gateway [--interval 60]` | Re-sync one gateway on a timer |

`login`, `logout` and `whoami` moved to `@almyty/auth`; typing them here
prints where they went and exits `2`.

## References

A skill is `org/gateway/skill`, a whole gateway is `org/gateway`, and a
gateway UUID also works. A leading `@` is optional — `@acme/billing`
and `acme/billing` are the same. A bare name is treated as a search,
and installs only when it matches exactly one skill; an ambiguous name
lists the matches and exits `2` rather than guessing.

```bash
$ npx @almyty/skills install acme/billing
$ npx @almyty/skills run acme/billing/get-invoice --id 123
```

## Where skills get installed

`install` writes one `SKILL.md` per skill into one or more agent
directories, at `<skillsDir>/<skill-name>/SKILL.md`. The CLI detects
agents at two scopes:

- **Project scope** — a config dir exists in the current project
  (e.g. `./.codex/`). Skills install to `./.codex/skills/`, so only
  this checkout sees them.
- **Home scope** — a config dir exists in your home directory
  (e.g. `~/.codex/`). Skills install to `~/.codex/skills/`, so every
  project that agent opens picks them up.

**Installing overwrites a `SKILL.md` of the same name** in the target
directory. Nothing else in those directories is touched, and `remove`
only deletes directories whose `SKILL.md` carries almyty's own
`metadata.author: almyty` marker. `install` prints the directories it is
about to write to before it writes anything, reports how many files it
replaced, and `--dry-run` lists every path and writes nothing:

```bash
$ npx @almyty/skills install acme/billing --dry-run

acme/billing (12 skill(s)) — dry run, nothing will be written:
  Codex: /work/proj/.codex/skills
  Universal (.agents/skills): /work/proj/.agents/skills

  Codex: 12 skill file(s) would go to /work/proj/.codex/skills
      /work/proj/.codex/skills/get-invoice/SKILL.md
      …

Dry run: 24 skill file(s) across 2 target(s), 3 of them replacing an existing file.
Re-run without --dry-run to write them.
```

### Choosing targets

- **Interactive terminal, no target flag:** a multi-select picker lists
  every detected agent at both scopes (labelled `(project)` or
  `(home)`), every other supported agent as opt-in, the universal
  `.agents/skills/` convention, and a custom-path option.
- **`--yes`, `--json`, CI, or a pipe:** the picker is skipped and
  install writes to the project-detected agents plus `.agents/skills/`.
  Home-detected agents are NOT installed automatically — pass
  `--global`.
- **`--global` alone:** every home-detected agent. No project install.
- **`--all`:** every project-detected agent plus universal. Combine with
  `--global` to include home-detected too.
- **`--agent <name>`:** the named agent at whichever scope it is
  detected in (project preferred). With `--global`, prefers home. If it
  is detected nowhere, creates the project-scope directory so the agent
  picks it up on its next scan.

| Flag | Meaning |
|------|---------|
| `--agent <name>`, `-a` | Install to the named agent. Repeatable, partial-match. |
| `--agent '*'` | Every known agent at project scope, regardless of detection. |
| `--path <dir>`, `-p` | Custom skills directory. Repeatable. Bypasses detection. |
| `--all` | Every project-detected agent + `.agents/skills/`. |
| `--global`, `-G` | Home scope (`~/.<agent>/skills/`). A modifier on `--agent`, or standalone for "every home-detected". |
| `--yes`, `-y` | Skip the picker; use the non-interactive defaults. |
| `--dry-run` | Print every file `install` would write, and write nothing. |

```bash
$ npx @almyty/skills install acme/billing                     # interactive picker
$ npx @almyty/skills install acme/billing --all               # every project-detected
$ npx @almyty/skills install acme/billing --all --global      # project AND home detected
$ npx @almyty/skills install acme/billing --global            # only home-detected agents
$ npx @almyty/skills install acme/billing -a codex            # codex, at whichever scope it lives
$ npx @almyty/skills install acme/billing -a codex --global   # force ~/.codex/skills
$ npx @almyty/skills install acme/billing --agent '*' -y      # every known agent, project scope
$ npx @almyty/skills install acme/billing -p ./agents/skills  # a directory you name
```

`src/agents.ts` is the registry: each entry maps a detection directory
to the `<dir>/skills` path that agent reads on session start.

## Other options

| Flag | Description |
|------|-------------|
| `--interval <s>`, `-i` | `daemon`/`watch` poll interval (default `60`) |
| `--url <url>` | API URL (default `https://api.almyty.com`) |
| `--dir <path>` | Project directory (default: cwd) |
| `--json` | Machine-readable output on every read command |
| `--help`, `-h` | Show help |
| `--version`, `-v` | Print the version |

Both `--flag value` and `--flag=value` are accepted. `run` forwards
every flag the CLI does not own to the skill as a parameter, so
`run acme/billing/get-invoice --invoiceId inv_123` sends `{ invoiceId: "inv_123" }`.

`run` prints its result as JSON always — the result *is* data. Every
other read command prints for humans by default and takes `--json`.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | success |
| `1` | unexpected error |
| `2` | usage error (bad flags, unknown command, ambiguous ref) |
| `3` | not authenticated — run `npx @almyty/auth login` |
| `4` | no such gateway or skill |
| `5` | the skill ran and failed |

## Configuration

`.almytyrc`, JSON, in the project directory or `$HOME`:

```json
{
  "skillsDir": ".agents/skills",
  "agents": ["Codex", "Claude Code"],
  "url": "https://api.almyty.com",
  "interval": 60
}
```

| Key | Effect |
|-----|--------|
| `skillsDir` | Install here and skip agent detection entirely |
| `agents` | Whitelist of agent names (partial match) to install to |
| `url` | API URL |
| `interval` | `daemon`/`watch` poll interval, in seconds |

There is **no credential key**. The token lives only in
`~/.almyty/credentials.json` (written by `npx @almyty/auth login`) or in
`ALMYTY_TOKEN`.

## Environment variables

| Variable | Description |
|----------|-------------|
| `ALMYTY_TOKEN` | Auth token override |
| `ALMYTY_URL` | API URL override |
| `ALMYTY_SKILLS_DIR` | Install directory override; wins over `.almytyrc` |
| `ALMYTY_NON_INTERACTIVE=1` | Never prompt, even in a terminal |
| `CI` | Any truthy value has the same effect |
| `NO_COLOR` | Drops colour from the interactive picker |

## Authentication

Run `npx @almyty/auth login` once. `search` and `list` are org-scoped —
they look through the gateways your account can see, so there is no
credential-free public index to search. With no credential, every
command that talks to the API prints the login instruction and exits
`3`; `installed` and `remove` are local and need none.

## About almyty

almyty is the full-stack platform for AI agents, agnostic by design: any LLM, any
API turned into tools, served over MCP, A2A, UTCP, and Agent Skills. Open source,
no lock-in.

- Website: https://almyty.com
- Docs: https://docs.almyty.com
- Source: https://github.com/almyty-inc/almyty

This CLI is part of the `@almyty/*` suite (versioned together at 1.x) and works with the almyty platform 0.1 and later.

Apache-2.0 © Almyty Inc.
