/**
 * Command line for `almyty chat`.
 *
 * Parsing lives apart from the entry point so the surface can be tested
 * without a terminal, and so `--help` is generated from the same table
 * the parser reads. A flag that exists and is undocumented, or is
 * documented and does not exist, is a bug either way.
 */

import { SLASH_COMMANDS, COMMAND_DESCS } from './commands.js';
import { EXIT_CODE_HELP } from './exit-codes.js';

export interface ChatArgs {
  help: boolean;
  version: boolean;
  /** `<org>/<agent-slug>`, a bare slug, or undefined for the picker. */
  ref?: string;
  resume?: string;
  /** One-shot message. Answers and exits, no REPL. */
  message?: string;
  /** Read the message from stdin rather than a tty. */
  stdin: boolean;
  json: boolean;
  /** False renders the answer once it is complete instead of token by token. */
  stream: boolean;
  /** Explicit colour choice; undefined means "decide from the terminal". */
  color?: boolean;
  maxSteps?: number;
  maxCostCents?: number;
  /** A parse problem worth exiting on, rather than guessing. */
  error?: string;
}

/** Flags that take no value. */
const BOOLEAN_FLAGS = new Set([
  '--help', '-h', '--version', '-v', '--json', '--stdin',
  '--no-stream', '--stream', '--no-color', '--color',
]);

/** Flags that consume the next argument. */
const VALUE_FLAGS = new Set(['--resume', '--message', '-m', '--max-steps', '--max-cost-cents']);

function positiveInt(raw: string, flag: string): { value?: number; error?: string } {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    return { error: `${flag} needs a positive whole number, got "${raw}"` };
  }
  return { value: n };
}

export function parseArgs(argv: string[]): ChatArgs {
  const args: ChatArgs = { help: false, version: false, stdin: false, json: false, stream: true };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        return { ...args, error: `${arg} needs a value` };
      }
      i++;
      switch (arg) {
        case '--resume': args.resume = value; break;
        case '--message': case '-m': args.message = value; break;
        case '--max-steps': {
          const { value: n, error } = positiveInt(value, arg);
          if (error) return { ...args, error };
          args.maxSteps = n;
          break;
        }
        case '--max-cost-cents': {
          const { value: n, error } = positiveInt(value, arg);
          if (error) return { ...args, error };
          args.maxCostCents = n;
          break;
        }
      }
      continue;
    }

    if (BOOLEAN_FLAGS.has(arg)) {
      switch (arg) {
        case '--help': case '-h': args.help = true; break;
        case '--version': case '-v': args.version = true; break;
        case '--json': args.json = true; break;
        case '--stdin': args.stdin = true; break;
        case '--stream': args.stream = true; break;
        case '--no-stream': args.stream = false; break;
        case '--color': args.color = true; break;
        case '--no-color': args.color = false; break;
      }
      continue;
    }

    if (arg.startsWith('-')) {
      // Silently ignoring an unknown flag is how `--jsonl` spends an
      // afternoon looking like a broken --json.
      return { ...args, error: `Unknown option: ${arg}\nRun with --help to see what this accepts.` };
    }

    if (args.ref === undefined) args.ref = arg;
    else return { ...args, error: `Unexpected argument: ${arg}. Pass a message with --message instead.` };
  }

  return args;
}

/**
 * The agent to open: the argument, else $ALMYTY_AGENT.
 *
 * The environment variable is how a compiled terminal app knows which
 * agent it is, since the build compiles this client unchanged and the
 * recipient should not have to type an agent reference.
 */
export function resolveRef(args: ChatArgs, env: Record<string, string | undefined> = process.env): string | undefined {
  return args.ref ?? (env.ALMYTY_AGENT || undefined);
}

/** Split `<org>/<agent>` into its parts; a bare slug leaves org unset. */
export function splitRef(ref: string): { orgSlug?: string; agentSlug: string } {
  const slash = ref.indexOf('/');
  if (slash === -1) return { agentSlug: ref };
  return { orgSlug: ref.slice(0, slash), agentSlug: ref.slice(slash + 1) };
}

/**
 * Whether to run without a terminal UI.
 *
 * A CLI that only works on a tty is half a CLI: piping in a question or
 * out to jq has to work, and ink cannot draw to a pipe.
 */
export function isNonInteractive(
  args: ChatArgs,
  io: { stdinTty?: boolean; stdoutTty?: boolean } = {},
): boolean {
  if (args.message !== undefined || args.json || args.stdin) return true;
  return io.stdinTty === false || io.stdoutTty === false;
}

/**
 * Whether to emit colour.
 *
 * Honours the NO_COLOR convention and FORCE_COLOR, and never colours a
 * pipe unless asked to.
 */
export function useColor(
  args: ChatArgs,
  env: Record<string, string | undefined> = process.env,
  stdoutTty = true,
): boolean {
  if (args.color !== undefined) return args.color;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0') return true;
  if (env.TERM === 'dumb') return false;
  return stdoutTty;
}

/**
 * `--help`, built from the same command table the REPL resolves
 * against, so a new slash command cannot go undocumented.
 */
export function helpText(version: string): string {
  const commands = SLASH_COMMANDS.map((cmd) => `  /${cmd.padEnd(11)}${COMMAND_DESCS[cmd] ?? ''}`).join('\n');
  return `almyty chat v${version} — an interactive REPL for your almyty agents.

Usage:
  almyty chat [<org>/<agent-slug>] [options]

  With no agent reference it lists the agents you can reach and asks.
  A bare slug uses the organization on your credentials.

Options:
  -m, --message <text>       Ask one question, print the answer, exit.
      --stdin                Read the question from stdin (for pipes).
      --resume <id>          Continue a previous conversation.
      --json                 One JSON object per answer. Implies non-interactive.
      --no-stream            Wait for the whole answer instead of streaming it.
      --no-color             Never colour the output. NO_COLOR is honoured too.
      --max-steps <n>        Autonomous runs: cap the number of steps.
      --max-cost-cents <n>   Autonomous runs: cap the spend, in cents.
  -h, --help                 Show this.
  -v, --version              Print the version.

Slash commands, inside the REPL:
${commands}

  Commands take unique prefixes and aliases: /q for /quit, /sw for /agents.
  Tab completes, up and down walk your input history.

Keys:
  Ctrl-C     Cancel the running answer (server-side too). Again to exit.
  Ctrl-D     Exit.
  Enter      Send. End a line with \\ to keep typing on the next one.

Non-interactive:
  almyty chat acme/support-bot -m "what is our refund window?"
  echo "summarise today's errors" | almyty chat acme/ops --stdin
  almyty chat acme/ops -m "check the deploy" --json | jq .output

  The answer goes to stdout and the attribution to stderr, so a pipe
  stays clean.

Exit codes:
${EXIT_CODE_HELP}

Environment:
  ALMYTY_TOKEN         Token override, instead of ~/.almyty/credentials.json.
  ALMYTY_URL           API URL override.
  ALMYTY_AGENT         Default agent reference, used when none is given.
  ALMYTY_APP_URL       Dashboard URL used in error messages.
  ALMYTY_CHAT_HISTORY  Input history file, instead of ~/.almyty/chat-history.
  NO_COLOR             Set to anything to disable colour.

Login:
  npx @almyty/auth login
`;
}
