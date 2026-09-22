/**
 * Command-line parsing for @almyty/skills.
 *
 * Its own module so the surface can be unit-tested without importing
 * the entry point (which would need a credential store and would run
 * main() on import).
 */
export interface ParsedArgs {
  command?: string;
  ref?: string;
  positional: string[];
  flags: Record<string, string | string[] | boolean>;
}

/**
 * Repeatable flags accumulate into a string[] when supplied more
 * than once. Used by `--agent` and `--path` so callers can pick
 * multiple targets without inventing comma syntax (the selector
 * also splits on comma/space, so both styles work).
 */
const REPEATABLE_FLAGS = new Set(['agent', 'path']);

/** Switches: never take a value, never swallow the next token. */
const BOOLEAN_FLAGS = new Set([
  'all',
  'yes',
  'global',
  'help',
  'version',
  'json',
  'dry-run',
]);

/**
 * Flags that belong to the CLI itself, so `run` does not forward them
 * to the skill as parameters. `--json` and `--dry-run` were added
 * later; without them here, `run x --json` would have sent the skill a
 * parameter called `json`.
 */
const RESERVED_FLAGS = new Set([
  'url',
  'dir',
  'help',
  'version',
  'interval',
  'gateway',
  'agent',
  'path',
  'all',
  'yes',
  'global',
  'json',
  'dry-run',
]);

function appendRepeatable(
  flags: Record<string, string | string[] | boolean>,
  key: string,
  value: string,
): void {
  const existing = flags[key];
  if (existing === undefined || existing === true || existing === false) {
    flags[key] = value;
  } else if (typeof existing === 'string') {
    flags[key] = [existing, value];
  } else {
    existing.push(value);
  }
}

function setFlag(
  flags: Record<string, string | string[] | boolean>,
  key: string,
  value: string,
): void {
  if (REPEATABLE_FLAGS.has(key)) appendRepeatable(flags, key, value);
  else flags[key] = value;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { positional: [], flags: {} };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--') {
      result.positional.push(...argv.slice(i + 1));
      break;
    }

    // Short aliases. `-g` stays on --gateway for back-compat; -G is
    // --global.
    if (arg === '-g') {
      result.flags.gateway = argv[++i] ?? '';
      continue;
    }
    if (arg === '-i') {
      result.flags.interval = argv[++i] ?? '60';
      continue;
    }
    if (arg === '-a') {
      appendRepeatable(result.flags, 'agent', argv[++i] ?? '');
      continue;
    }
    if (arg === '-p') {
      appendRepeatable(result.flags, 'path', argv[++i] ?? '');
      continue;
    }
    if (arg === '-y') {
      result.flags.yes = true;
      continue;
    }
    if (arg === '-G') {
      result.flags.global = true;
      continue;
    }
    if (arg === '-h') {
      result.flags.help = true;
      continue;
    }
    if (arg === '-v') {
      result.flags.version = true;
      continue;
    }

    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        // `--agent=codex` and `--input={"a":1}` both used to become a
        // flag whose NAME was the whole `key=value` string.
        setFlag(result.flags, body.slice(0, eq), body.slice(eq + 1));
        continue;
      }
      if (BOOLEAN_FLAGS.has(body)) {
        result.flags[body] = true;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        setFlag(result.flags, body, next);
        i++;
      } else {
        result.flags[body] = true;
      }
      continue;
    }

    // A bare word containing a slash is a gateway/skill reference.
    if (arg.includes('/')) {
      result.ref = arg;
      continue;
    }

    if (!result.command) result.command = arg;
    else result.positional.push(arg);
  }

  return result;
}

export function getRef(args: ParsedArgs): string | null {
  if (args.ref) return args.ref;
  if (typeof args.flags.gateway === 'string' && args.flags.gateway) {
    return args.flags.gateway;
  }
  if (args.positional.length > 0) return args.positional[0];
  return null;
}

export function parseRunParams(args: ParsedArgs): Record<string, any> {
  const params: Record<string, any> = {};
  for (const [key, value] of Object.entries(args.flags)) {
    if (RESERVED_FLAGS.has(key)) continue;
    params[key] = value;
  }
  return params;
}
