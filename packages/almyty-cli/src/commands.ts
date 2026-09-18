/**
 * The umbrella's routing table, help text, and shell completion.
 *
 * Kept out of index.ts so it can be unit-tested without spawning a
 * child process: every entry here must be listed in the help text and
 * must name a package the umbrella actually depends on, and there are
 * tests that assert both.
 */

export interface Subcommand {
  /** Package name to delegate to. */
  pkg: string;
  /**
   * Optional argv prefix injected before the user-supplied args.
   * Used for top-level shortcuts like `almyty login` -> `@almyty/auth login`.
   */
  prefixArgs?: string[];
  /** Short help line shown by `almyty help`. */
  help: string;
  /** Section heading this command is grouped under in the help output. */
  group: string;
  /** Subcommand names, for shell completion. Empty when it takes free-form args. */
  subcommands?: string[];
}

/**
 * Top-level subcommand routing table. Order = display order in help.
 *
 * Every `pkg` here must be a dependency of @almyty/cli. `models` and
 * `connections` were listed in the help text while the umbrella did
 * not depend on them, so `almyty models list` answered "package
 * @almyty/models is not installed" for a command its own --help
 * advertised.
 */
export const SUBCOMMANDS: Record<string, Subcommand> = {
  // Auth shortcuts at top level (gh-style: `almyty login` not `almyty auth login`)
  login: { pkg: '@almyty/auth', prefixArgs: ['login'], group: 'Auth', help: 'Browser-based login (writes ~/.almyty/credentials.json)' },
  logout: { pkg: '@almyty/auth', prefixArgs: ['logout'], group: 'Auth', help: 'Remove stored credentials' },
  whoami: { pkg: '@almyty/auth', prefixArgs: ['whoami'], group: 'Auth', help: 'Show the current identity' },
  auth: { pkg: '@almyty/auth', group: 'Auth', help: 'Auth subcommands', subcommands: ['login', 'logout', 'whoami'] },

  // Domain CLIs
  agents: { pkg: '@almyty/agents', group: 'Agents', help: 'List, run, and inspect agents', subcommands: ['list', 'get', 'run', 'runs', 'inspect', 'executions', 'trace', 'cancel'] },
  chat: { pkg: '@almyty/chat', group: 'Agents', help: 'Interactive chat REPL with an agent' },
  skills: { pkg: '@almyty/skills', group: 'Skills', help: 'Install API skills into AI coding agents', subcommands: ['install', 'list', 'search', 'run', 'installed', 'remove', 'gateways', 'daemon', 'watch'] },
  models: { pkg: '@almyty/models', group: 'Platform', help: 'Model catalog: cards, validation, deployments' },
  connections: { pkg: '@almyty/connections', group: 'Platform', help: 'Connect third-party accounts: connectors, validate, grants' },
  runner: { pkg: '@almyty/runner', group: 'Serving', help: 'Run agents on this machine as a daemon' },
  mcp: { pkg: '@almyty/mcp-server', group: 'Serving', help: 'Serve your agents and tools over MCP' },
  acp: { pkg: '@almyty/acp-server', group: 'Serving', help: 'Serve an agent over the Agent Client Protocol' },
};

/** Commands the umbrella answers itself, rather than delegating. */
export const BUILTIN_COMMANDS = ['help', 'version', 'completion'] as const;

/** Every name `almyty <x>` accepts, for completion and suggestions. */
export function allCommandNames(): string[] {
  return [...Object.keys(SUBCOMMANDS), ...BUILTIN_COMMANDS];
}

/**
 * A short tour, printed when `almyty` is run with no arguments.
 *
 * A bare `almyty` used to print the entire command reference, which is
 * the least useful thing to show someone who has just installed it and
 * does not yet know what the product does.
 */
export function tourText(version: string): string {
  return `almyty v${version} — build, run, and serve AI agents.

Start here:
  almyty login                     Authenticate this machine
  almyty agents list               See the agents in your organization
  almyty agents run <agent>        Run one and print its output
  almyty chat <agent>              Talk to one in your terminal
  almyty skills install <ref>      Teach your coding agent an API

  almyty help                      Every command, grouped
  almyty <command> --help          Detail for one command

Docs: https://docs.almyty.com`;
}

/** The full command reference, printed by `almyty help` / `--help`. */
export function helpText(version: string): string {
  const groups = new Map<string, string[]>();
  const width = Math.max(
    ...Object.keys(SUBCOMMANDS).map((n) => n.length),
    'completion <shell>'.length,
  );

  for (const [name, sub] of Object.entries(SUBCOMMANDS)) {
    const lines = groups.get(sub.group) ?? [];
    lines.push(`  ${name.padEnd(width)}  ${sub.help}`);
    groups.set(sub.group, lines);
  }

  const sections = [...groups.entries()]
    .map(([group, lines]) => `${group}:\n${lines.join('\n')}`)
    .join('\n\n');

  return `almyty CLI v${version}

Usage:
  almyty <command> [args]
  almyty <command> --help          Full options for that command

${sections}

Other:
  ${'help'.padEnd(width)}  Show this help
  ${'version'.padEnd(width)}  Print the version
  ${'completion <shell>'.padEnd(width)}  Print a completion script (bash, zsh, fish)

Exit codes (the same in every almyty CLI):
  0  success
  1  unexpected error
  2  usage error (bad flags, unknown command)
  3  not authenticated — run \`almyty login\`
  4  not found (agent, gateway, skill, or run)
  5  the operation ran and failed

Every subcommand is also a standalone package, so nothing here is
required in order to use one of them:

  npx @almyty/auth login
  npx @almyty/agents list
  npx @almyty/chat my-research-bot
  npx @almyty/skills install org/gateway

They all read the same credentials file (~/.almyty/credentials.json),
so \`almyty login\` logs all of them in at once.`;
}

/** Levenshtein distance, capped — only used to suggest a command name. */
function distance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = Array.from({ length: cols }, (_, j) => j);
  for (let i = 1; i < rows; i++) {
    const curr = [i];
    for (let j = 1; j < cols; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[cols - 1];
}

/**
 * The closest command name to what the user typed, or null.
 * `almyty agent list` (singular) should not just say "unknown command".
 */
export function suggestCommand(input: string): string | null {
  const typed = input.toLowerCase();
  let best: string | null = null;
  let bestScore = Infinity;
  for (const name of allCommandNames()) {
    const d = distance(typed, name);
    if (d < bestScore) {
      bestScore = d;
      best = name;
    }
  }
  const tolerance = typed.length <= 4 ? 1 : 2;
  return best !== null && bestScore <= tolerance ? best : null;
}

export const COMPLETION_SHELLS = ['bash', 'zsh', 'fish'] as const;
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

export function isCompletionShell(value: string): value is CompletionShell {
  return (COMPLETION_SHELLS as readonly string[]).includes(value);
}

/**
 * A completion script for one shell. Static — it lists the top-level
 * commands and each one's own subcommands from the table above, so it
 * never has to shell out to the sub-CLIs to build a candidate list.
 */
export function completionScript(shell: CompletionShell): string {
  const top = allCommandNames().join(' ');

  if (shell === 'bash') {
    const cases = Object.entries(SUBCOMMANDS)
      .filter(([, s]) => s.subcommands?.length)
      .map(([name, s]) => `    ${name}) subs="${s.subcommands!.join(' ')}" ;;`)
      .join('\n');
    return `# almyty bash completion — add to ~/.bashrc:
#   eval "$(almyty completion bash)"
_almyty_complete() {
  local cur prev subs
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${top}" -- "$cur") )
    return
  fi
  subs=""
  case "\${COMP_WORDS[1]}" in
${cases}
    completion) subs="bash zsh fish" ;;
  esac
  if [ -n "$subs" ] && [ "$COMP_CWORD" -eq 2 ]; then
    COMPREPLY=( $(compgen -W "$subs" -- "$cur") )
  fi
}
complete -F _almyty_complete almyty`;
  }

  if (shell === 'zsh') {
    const descs = Object.entries(SUBCOMMANDS)
      .map(([name, s]) => `    '${name}:${s.help.replace(/'/g, '')}'`)
      .join('\n');
    return `# almyty zsh completion — add to ~/.zshrc:
#   eval "$(almyty completion zsh)"
_almyty() {
  local -a commands
  commands=(
${descs}
    'help:Show help'
    'version:Print the version'
    'completion:Print a shell completion script'
  )
  if (( CURRENT == 2 )); then
    _describe -t commands 'almyty command' commands
  fi
}
compdef _almyty almyty`;
  }

  const fishLines = Object.entries(SUBCOMMANDS)
    .map(
      ([name, s]) =>
        `complete -c almyty -n __fish_use_subcommand -a ${name} -d '${s.help.replace(/'/g, '')}'`,
    )
    .join('\n');
  return `# almyty fish completion — save as ~/.config/fish/completions/almyty.fish:
#   almyty completion fish > ~/.config/fish/completions/almyty.fish
${fishLines}
complete -c almyty -n __fish_use_subcommand -a help -d 'Show help'
complete -c almyty -n __fish_use_subcommand -a version -d 'Print the version'
complete -c almyty -n __fish_use_subcommand -a completion -d 'Print a shell completion script'`;
}
