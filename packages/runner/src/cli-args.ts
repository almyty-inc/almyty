/**
 * The almyty-runner command line, parsed.
 *
 * Kept apart from cli.ts, which pulls in the daemon and node-pty, so the
 * surface can be unit-tested without a runtime. Every other almyty CLI
 * splits its arguments out the same way.
 */

export interface ParsedFlags {
  command: 'start' | 'status' | 'stop' | 'help' | 'version';
  name?: string;
  url?: string;
  configPath?: string;
  labels?: Record<string, string>;
  /** --org: the organization to register in (X-Organization-Id). */
  org?: string;
  /**
   * A usage problem worth exiting on. Parsing reports it rather than
   * exiting itself, so the surface can be tested without a process, and
   * so every usage problem leaves through one place with one exit code.
   */
  error?: string;
}

export const COMMANDS = ['start', 'status', 'stop', 'help', 'version'] as const;

const VALUE_FLAGS = ['--name', '--config', '--url', '--label', '--org'];

/** Takes a full argv; the first two entries are node and the script. */
export function parseArgs(argv: string[]): ParsedFlags {
  const args = argv.slice(2);
  if (args.length === 0) return { command: 'help' };
  const command = args[0];
  if (command === '--version' || command === '-v') return { command: 'version' };
  if (command === '--help' || command === '-h') return { command: 'help' };

  if (!(COMMANDS as readonly string[]).includes(command)) {
    // Printing help and exiting 0 told a script that a typo had worked.
    return {
      command: 'help',
      error: `Unknown command: ${command}\nCommands: ${COMMANDS.join(', ')}. Run \`almyty-runner --help\` for detail.`,
    };
  }

  const flags: ParsedFlags = { command: command as ParsedFlags['command'] };
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') return { command: 'help' };
    if (VALUE_FLAGS.includes(a)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('-')) {
        return { ...flags, error: `${a} needs a value` };
      }
      i++;
      if (a === '--name') { flags.name = value; continue; }
      if (a === '--config') { flags.configPath = value; continue; }
      if (a === '--url') { flags.url = value; continue; }
      if (a === '--org') { flags.org = value; continue; }
      const eq = value.indexOf('=');
      if (eq <= 0) return { ...flags, error: `--label expects key=value, got: ${value}` };
      flags.labels = flags.labels ?? {};
      flags.labels[value.slice(0, eq)] = value.slice(eq + 1);
      continue;
    }
    // Silently dropping an unknown flag is how `--nmae` spends an
    // afternoon looking like a runner that ignores its own name.
    return { ...flags, error: `Unknown option: ${a}\nRun \`almyty-runner --help\` to see what ${flags.command} accepts.` };
  }
  return flags;
}
