/**
 * `--help` for @almyty/skills.
 *
 * Kept in its own module so the text can be asserted against the code's
 * real surface: there are tests that every dispatched command, every
 * parsed flag and every environment variable the code reads appears
 * here. `watch` was implemented and dispatched while appearing nowhere
 * in --help, which is how a command becomes source-only folklore.
 */
import { VERSION } from './version.js';
import { AGENT_CONFIGS } from './agents.js';

export function helpText(): string {
  return `@almyty/skills v${VERSION}

Turn any API in your almyty gateways into a SKILL.md your coding agent
reads on its next session. ${AGENT_CONFIGS.length} agents are recognised, plus the universal
.agents/skills/ convention.

Usage:
  npx @almyty/skills <command> [options]

Commands:
  install <ref>                  Write skills into local AI coding agents
  list [ref]                     Skills available to you, all or per gateway
  search <query>                 Search your gateways' skills by keyword
  run <ref> [--key value ...]    Execute one skill and print its result
  installed                      Skills this CLI has installed here
  remove                         Remove every skill this CLI installed here
  gateways                       Your gateways, and the ref to install each
  daemon                         Re-sync every skill on a timer
  watch <ref>                    Re-sync one gateway on a timer
  help                           Show this help

References:
  org/gateway                    All skills from one gateway
  org/gateway/skill              One skill
  skill-name                     Search by name, install if it is unambiguous
  <uuid>                         A gateway by id
  A leading @ is optional: @acme/billing and acme/billing are the same.

Install targets:
  --agent, -a <name>             Install to the named agent. Repeatable,
                                 partial match ("-a codex -a claude").
                                 '*' or 'all' means every known agent.
  --path, -p <dir>               Install to this directory. Repeatable.
                                 Bypasses agent detection entirely.
  --all                          Every PROJECT-detected agent, plus the
                                 universal .agents/skills/. Skips the picker.
  --global, -G                   Home scope (~/.codex/skills/ etc.) instead
                                 of project scope. With --all, adds
                                 home-detected agents to the project ones.
  --yes, -y                      Skip the picker; use the non-interactive
                                 defaults (project-detected + universal).
  --dry-run                      Print every file install would write, and
                                 write nothing.

Options:
  --interval, -i <seconds>       daemon/watch poll interval (default 60)
  --url <url>                    API URL (default https://api.almyty.com)
  --dir <path>                   Project directory (default: cwd)
  --json                         Machine-readable output, no decoration
  --help, -h                     Show this help
  --version, -v                  Print the version

Config (.almytyrc, in the project dir or $HOME, JSON):
  skillsDir                      Install here and skip detection
  agents                         Whitelist of agent names to install to
  url                            API URL
  interval                       daemon/watch poll interval, in seconds
  The credential is NOT read from here — it lives in
  ~/.almyty/credentials.json, written by \`npx @almyty/auth login\`.

Environment:
  ALMYTY_TOKEN                   Token override
  ALMYTY_URL                     API URL override
  ALMYTY_SKILLS_DIR              Install directory override
  ALMYTY_NON_INTERACTIVE=1       Never prompt, even in a terminal
  CI                             Same effect as ALMYTY_NON_INTERACTIVE
  NO_COLOR                       Drop colour from the interactive picker

Target selection:
  With no target flag in an interactive terminal, install shows a
  multi-select picker: detected agents pre-checked, every other known
  agent as opt-in, the universal directory, and a custom path. In CI or
  a pipe the picker is skipped and install writes to the detected agents
  plus .agents/skills/ — run --dry-run first to see exactly where.

Installing overwrites a SKILL.md of the same name in the target
directory. Nothing else in those directories is touched, and \`remove\`
only deletes skills carrying almyty's own frontmatter marker.

Exit codes:
  0  success
  1  unexpected error
  2  usage error (bad flags, unknown command)
  3  not authenticated — run \`npx @almyty/auth login\`
  4  no such gateway or skill
  5  the skill ran and failed

Examples:
  npx @almyty/skills gateways
  npx @almyty/skills install acme/billing --dry-run
  npx @almyty/skills install acme/billing -a codex -a claude
  npx @almyty/skills install acme/billing --all --global
  npx @almyty/skills search weather --json
  npx @almyty/skills run acme/billing/get-invoice --invoiceId inv_123
`;
}

export function printHelp(): void {
  console.log(helpText());
}
