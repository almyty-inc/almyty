/**
 * Argument parsing shared in shape (not in code) by every almyty CLI.
 *
 * Conventions, so `almyty agents …` and `almyty auth …` never disagree:
 *   - long flags only for options: `--input`, `--json`, `--max-steps`
 *   - `--flag value` and `--flag=value` are both accepted. Only the
 *     space form used to work, so `--input='{"a":1}'` silently became a
 *     flag literally named `input={"a":1}` and the input was dropped.
 *   - `-h` / `--help` and `-v` / `--version` are the only short flags
 *   - a flag declared boolean never swallows the next token
 *   - the first bare word is the command; the rest are positional
 */

export interface ParsedArgs {
  command?: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

/** Flags every almyty CLI understands, and which never take a value. */
export const COMMON_BOOLEAN_FLAGS = ['help', 'version', 'json'] as const;

export function parseArgs(
  argv: string[],
  booleanFlags: readonly string[] = COMMON_BOOLEAN_FLAGS,
): ParsedArgs {
  const booleans = new Set<string>([...COMMON_BOOLEAN_FLAGS, ...booleanFlags]);
  const result: ParsedArgs = { positional: [], flags: {} };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '-h') {
      result.flags.help = true;
      continue;
    }
    if (arg === '-v') {
      result.flags.version = true;
      continue;
    }
    if (arg === '--') {
      // Everything after `--` is positional, flags included.
      result.positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        result.flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      if (booleans.has(body)) {
        result.flags[body] = true;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        result.flags[body] = next;
        i++;
      } else {
        result.flags[body] = true;
      }
      continue;
    }

    if (!result.command) result.command = arg;
    else result.positional.push(arg);
  }

  return result;
}

/** A flag's value as a string, or undefined when it was absent or bare. */
export function flagString(
  flags: ParsedArgs['flags'],
  name: string,
): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * A flag's value as a finite number. Throws a usage message rather than
 * letting `NaN` reach the API, which answered a 400 with a validation
 * body the user had to decode.
 */
export function flagNumber(
  flags: ParsedArgs['flags'],
  name: string,
): number | undefined {
  const raw = flagString(flags, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`--${name} needs a number, got ${JSON.stringify(raw)}`);
  }
  return value;
}
