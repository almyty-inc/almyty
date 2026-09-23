/**
 * Exit codes shared by every almyty CLI.
 *
 * Scripts need to tell "you are not logged in" apart from "the server
 * fell over" without grepping stderr. Every almyty CLI uses this same
 * table, so `npx @almyty/mcp-server acme/petstore || case $? in 3)
 * almyty login;; esac` behaves the same whichever binary produced the
 * code. This one used to exit 1 for a missing credential, which told a
 * supervisor to restart a server that would never start.
 *
 * Kept as a copy rather than an import: these CLIs are published
 * separately and this table is six numbers that must never drift, which
 * a test in each package pins.
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
  /** The named gateway does not exist. */
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
  '  3  not authenticated — run `npx @almyty/auth login`',
  '  4  not found (no such gateway)',
  '  5  the operation ran and failed',
].join('\n');

/**
 * Classify a startup failure into an exit code.
 *
 * The proxy turns a 401 into "Authentication failed" and everything else
 * into "API error <status>", so the status is what there is to go on. A
 * dead token discovered on the first call has to leave with the same code
 * as no token at all, or a supervisor cannot tell a restart from a login.
 */
export function exitCodeFor(err: unknown): ExitCode {
  const message = err instanceof Error ? err.message : String(err);
  if (/Authentication failed|\b401\b|\b403\b/.test(message)) return EXIT.AUTH;
  if (/\b404\b/.test(message)) return EXIT.NOT_FOUND;
  return EXIT.ERROR;
}
