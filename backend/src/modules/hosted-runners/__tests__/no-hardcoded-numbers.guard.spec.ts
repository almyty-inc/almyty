import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

/**
 * "Make it configurable, don't hardcode" (Frane, 2026-10-08): every
 * timeout, retention period, pod size, quota and concurrency number of
 * hosted runners comes from the settings (hosted-runner-settings.ts,
 * overridable by HOSTED_RUNNERS_SETTINGS) or from plan capacity, never
 * from a literal in the logic.
 *
 * So the module's code may hold a number only when it is not a tunable:
 * a unit conversion, a protocol constant, a structural count. Each one
 * allowed is listed with its reason; a new literal fails until someone
 * decides it is one of those, or moves it into the settings.
 */
const MODULE = join(__dirname, '..');
const SETTINGS = 'hosted-runner-settings.ts';

const ALLOWED: Record<string, string> = {
  '0': 'zero: none, empty, scale to zero',
  '1': 'one: one pod per workspace, scale to one, a single-use token, an off-by-one',
  '24': 'hours in a day (unit conversion)',
  '60': 'minutes in an hour (unit conversion)',
  '1000': 'milliseconds in a second (unit conversion)',
  '60_000': 'milliseconds in a minute (unit conversion)',
  '32': 'bytes of randomness in an enrollment token (a security constant, not a tunable)',
  '53': 'the DNS port (protocol constant)',
  '64': 'the runner name\'s maximum length, from its validation rule',
  '8': 'characters of a workspace id in a generated runner name',
  '10': 'characters of an ISO date (YYYY-MM-DD) in a notice',
  '3': 'decimal places kept when multiplying a Kubernetes quantity',
  '300': 'characters of a pod status message kept; the HTTP status from which a call failed',
  '500': 'characters of an error kept in a short form',
  '2000': 'characters of an error kept on the row',
  '253': 'a DNS name\'s maximum length (RFC 1035)',
  '61': 'a DNS label\'s middle characters (RFC 1035)',
  '62': 'a DNS label\'s middle characters (RFC 1035)',
  '15': 'characters of a resource class name after its first, from its validation rule',
  '16': 'a resource class name\'s column width',
  '63': 'an environment name\'s characters after its first, from its validation rule',
  '127': 'characters of an environment variable name after its first',
  '128': 'a field or binary name\'s maximum length',
  '255': 'a git ref\'s maximum length',
  '256': 'an enrollment token\'s maximum length on the wire',
  '512': 'a cache path\'s maximum length',
  '2048': 'a repository URL\'s maximum length',
  '65536': 'a setup script\'s maximum length',
  '200': 'the HTTP status below which a call succeeded (2xx)',
  '404': 'HTTP 404, already gone',
};

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== '__tests__') sources(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts') && entry !== SETTINGS) {
      out.push(full);
    }
  }
  return out;
}

/** Numeric literals outside comments and strings. */
export function numbersIn(source: string): string[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/`(?:\\.|[^`\\])*`/g, (t) => t.replace(/\$\{([^}]*)\}/g, ' $1 ').replace(/[^${}\s]/g, ' '))
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/\/(?:\\.|[^/\\\n])+\/[gimsuy]*/g, '//');
  return [...code.matchAll(/(?<![\w.$])(\d[\d_]*(?:\.\d+)?)(?![\w])/g)].map((m) => m[1]);
}

describe('hosted runners hold no tunable numbers in code', () => {
  const files = sources(MODULE);

  it('reads the module', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('every number in the module code is a unit, a protocol constant or a structural count', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const n of numbersIn(readFileSync(file, 'utf8'))) {
        if (!(n in ALLOWED)) offenders.push(`${relative(MODULE, file).split(sep).join('/')}: ${n}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the decided numbers live in the settings defaults, not elsewhere', () => {
    const settings = readFileSync(join(MODULE, SETTINGS), 'utf8');
    expect(settings).toMatch(/idleTimeoutMinutes: \{ default: 15, min: 5, max: 120 \}/);
    expect(settings).toMatch(/suspendedRetention: \{ keepDays: 30, noticeDay: 23 \}/);
  });

  it('sees a literal when there is one', () => {
    expect(numbersIn('const idle = 15 * 60_000; // 15 minutes')).toEqual(['15', '60_000']);
    expect(numbersIn("const s = '30 days'; const re = /\\d{2}/;")).toEqual([]);
  });
});
