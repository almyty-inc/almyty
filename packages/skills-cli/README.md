# @almyty/skills

Install and manage almyty skills in 30+ AI coding agents (Claude Code, Cursor, Windsurf, Copilot, Codex, and more).

## Quick start

```bash
$ npx @almyty/auth login
$ npx @almyty/skills gateways
$ npx @almyty/skills install org/gateway
```

## Commands

| Command | Description |
|---------|-------------|
| `gateways` | List your gateways |
| `list` | List all available skills |
| `list org/gateway` | List skills from one gateway |
| `search <query>` | Search skills by keyword |
| `install org/gateway` | Install all skills from a gateway |
| `install org/gateway/skill` | Install a single skill |
| `installed` | Show locally installed skills |
| `remove` | Remove all installed skills |
| `run org/gateway/skill [--key value]` | Execute a skill |
| `daemon [--interval 60]` | Sync all skills on a schedule |
| `watch org/gateway [--interval 60]` | Watch a specific gateway for changes |

## References

Skills are referenced as `org/gateway` or `org/gateway/skill`:

```bash
$ npx @almyty/skills install acme/petstore
$ npx @almyty/skills run acme/petstore/get-pet --id 123
```

## Where skills get installed

`install` writes a `SKILL.md` file per skill into one or more agent
directories. The CLI detects agents at two scopes:

- **Project scope** — a config dir exists in the current project
  (e.g. `./.codex/`). Skills install to `./.codex/skills/`, only
  this checkout sees them.
- **Home scope** — a config dir exists in your home directory
  (e.g. `~/.codex/`). Skills install to `~/.codex/skills/`, every
  project the agent opens picks them up.

Default behavior:

- **Interactive (TTY, no flags):** the picker lists every detected
  agent at both scopes (each labeled `(project)` or `(home)`),
  every other supported agent as opt-in, the universal
  `.agents/skills/` convention, and a custom-path option. Pick any
  combination.
- **`--yes` or non-TTY:** project-detected agents + `.agents/skills/`.
  Home-detected agents are NOT installed automatically — pass
  `--global` to opt in.
- **`--global` alone:** every home-detected agent. No project install.
- **`--all`:** every project-detected agent + universal. Combine
  with `--global` to also include home-detected.
- **`--agent <name>`:** install to a specific agent. Picks the
  detected scope (project preferred). With `--global`, prefers
  home. If neither is detected, creates the project-scope dir
  (the agent will pick it up on next scan).

| Flag | Meaning |
|------|---------|
| `--agent <name>`, `-a` | Install to the named agent. Repeatable. Partial-match. |
| `--agent '*'` | Every known agent at project scope, regardless of detection. |
| `--path <dir>`, `-p` | Custom skills directory. Repeatable. Bypasses detection. |
| `--all` | Every project-detected agent + `.agents/skills/`. |
| `--global`, `-G` | Use home scope (`~/.<agent>/skills/`). Modifier on `--agent`, or standalone for "every home-detected". |
| `--yes`, `-y` | Skip the picker; use the non-interactive defaults. |

Examples:

```bash
$ npx @almyty/skills install acme/petstore                          # interactive picker
$ npx @almyty/skills install acme/petstore --all                    # every project-detected
$ npx @almyty/skills install acme/petstore --all --global           # project AND home detected
$ npx @almyty/skills install acme/petstore --global                 # only home-detected agents
$ npx @almyty/skills install acme/petstore -a codex                 # codex at whichever scope it lives
$ npx @almyty/skills install acme/petstore -a codex --global        # force codex at ~/.codex/skills
$ npx @almyty/skills install acme/petstore --agent '*' -y           # every known agent at project
$ npx @almyty/skills install acme/petstore -p ./agents/skills       # custom directory
```

The 25+ supported agents include Claude Code, Codex, Cursor, Windsurf,
GitHub Copilot, Gemini CLI, Amp, Cline, Continue, Goose, Junie, Roo
Code, Trae, OpenHands, OpenCode, Augment, and others. See
`src/agents.ts` for the full registry — each entry maps a detection
directory to the `<dir>/skills` path that agent reads on session start.

## Configuration

Create `.almytyrc` in your project or home directory:

```json
{
  "url": "https://api.almyty.com",
  "token": "your-token"
}
```

## Environment variables

| Variable | Description |
|----------|-------------|
| `ALMYTY_TOKEN` | Auth token override |
| `ALMYTY_URL` | API URL override |
| `ALMYTY_SKILLS_DIR` | Custom directory for installed skill files |

## Authentication

Requires `npx @almyty/auth login` first. Reads credentials from `~/.almyty/credentials.json`.

## Docs

https://almyty.com/docs

## License

BSL-1.1
