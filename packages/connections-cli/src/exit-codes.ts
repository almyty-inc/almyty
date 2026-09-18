/**
 * Exit codes shared by every almyty CLI.
 *
 * Scripts need to tell "you are not logged in" apart from "that card does
 * not exist" apart from "the validation run failed" without grepping
 * stderr. Every almyty CLI uses this same table, so
 * `almyty models validate x || case $? in 3) almyty auth login;; esac`
 * behaves the same whichever binary produced the code.
 *
 * Kept as a copy rather than an import: these CLIs are published
 * separately and this table is six numbers that must never drift, which a
 * test in each package pins.
 */
export const EXIT = {
  /** Success. */
  OK: 0,
  /** Unexpected failure (a thrown error with no better classification). */
  ERROR: 1,
  /** Bad or missing arguments, or an unknown command. */
  USAGE: 2,
  /** No stored credential, or the API rejected the one we had. */
  AUTH: 3,
  /** The named card, deployment, connection or grant does not exist. */
  NOT_FOUND: 4,
  /** The command ran; the operation it asked for failed. */
  FAILED: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** One line per code, for `--help` output and READMEs. */
export const EXIT_CODE_HELP = [
  '  0  success',
  '  1  unexpected error',
  '  2  usage error (bad flags, unknown command)',
  '  3  not authenticated — run `almyty auth login`',
  '  4  not found',
  '  5  the operation ran and failed',
].join('\n');

/** Errors the CLI raises itself for a bad invocation, so they exit 2. */
export class UsageError extends Error {}

/**
 * Classify a thrown error into an exit code.
 *
 * The shared client turns a 401 into "Authentication failed. Run: npx
 * @almyty/auth login" and everything else into "API error <status>: <body>",
 * so the status is what there is to go on.
 */
export function exitCodeFor(err: unknown): ExitCode {
  if (err instanceof UsageError) return EXIT.USAGE;
  const message = err instanceof Error ? err.message : String(err);
  if (/^--|is required|must be|contradict|nothing to set|unknown command/i.test(message)) return EXIT.USAGE;
  if (/Authentication failed|\bAPI error 401\b|\b403\b/.test(message)) return EXIT.AUTH;
  if (/\bAPI error 404\b/.test(message)) return EXIT.NOT_FOUND;
  if (/\bAPI error 4\d\d\b|\bAPI error 5\d\d\b/.test(message)) return EXIT.FAILED;
  return EXIT.ERROR;
}

/**
 * What to print when a command fails.
 *
 * Node's fetch says `fetch failed` and nothing else, which tells the reader
 * neither which host was unreachable nor that the URL is theirs to change.
 * Every message here names the next thing to do.
 */
export function describeError(err: unknown, apiUrl?: string): string {
  const message = err instanceof Error ? err.message : String(err);
  const where = apiUrl ? ` at ${apiUrl}` : '';
  if (/Authentication failed|\bAPI error 401\b/.test(message)) {
    return 'Not authenticated: the stored token is missing or has expired.\n  Run: npx @almyty/auth login   (or set ALMYTY_TOKEN)';
  }
  if (/\bAPI error 403\b/.test(message)) {
    return `${message}\n  The token is valid but lacks permission here. An organization connection needs connections:manage (admin or owner).`;
  }
  if (/\bAPI error 404\b/.test(message)) {
    return `${message}\n  No such id, or it belongs to another organization.`;
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|other side closed|socket hang up/i.test(message)) {
    return `Could not reach the almyty API${where}: ${message}\n  Check ALMYTY_URL and the network, then try again.`;
  }
  if (/certificate|self.signed|SSL/i.test(message)) {
    return `TLS handshake with the almyty API${where} failed: ${message}`;
  }
  if (/ENOENT/.test(message)) {
    return `${message}\n  The file named by --input-file or --config-file does not exist.`;
  }
  return message;
}
