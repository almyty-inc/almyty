/**
 * Exit codes shared by every almyty CLI.
 *
 * Scripts need to tell "you are not logged in" apart from "that agent
 * does not exist" apart from "the run you asked for failed" without
 * grepping stderr. Every almyty CLI uses this same table, so
 * `almyty agents run x || case $? in 3) almyty login;; esac` behaves
 * the same whichever binary produced the code.
 */
import { inspectError } from './errors.js';

export const EXIT = {
  /** Success. */
  OK: 0,
  /** Unexpected failure (a thrown error with no better classification). */
  ERROR: 1,
  /** Bad or missing arguments, or an unknown command. */
  USAGE: 2,
  /** No stored credential, or the API rejected the one we had. */
  AUTH: 3,
  /** The named agent / gateway / skill / run does not exist. */
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
  '  3  not authenticated — run `almyty login`',
  '  4  not found (agent, gateway, skill, or run)',
  '  5  the operation ran and failed',
].join('\n');

/**
 * Classify a thrown value into an exit code.
 *
 * The sibling CLIs read the status back out of the message string.
 * This one does not have to: the shared client now puts `status` on
 * the error it throws, which `inspectError` reads.
 */
export function exitCodeForError(err: unknown): ExitCode {
  const f = inspectError(err);
  if (f.aborted) return EXIT.FAILED;
  if (f.network) return EXIT.ERROR;
  if (f.code === 'AGENT_AUTH_REQUIRED' || f.code === 'AGENT_AUTH_INVALID' || f.code === 'AGENT_AUTH_EXPIRED') return EXIT.AUTH;
  if (f.status === 401 || f.status === 403 || f.code === 'AGENT_AUTH_FORBIDDEN') return EXIT.AUTH;
  if (f.status === 404) return EXIT.NOT_FOUND;
  if (f.status !== undefined && f.status >= 400) return EXIT.FAILED;
  return EXIT.ERROR;
}

/**
 * The exit code a finished turn earns, so a chat call can gate a shell
 * script: a run that ran and failed is 5, not 1, so
 * `almyty chat deploy-check -m "ok?" || case $? in 5) ...` can tell a
 * failed answer from a broken invocation.
 */
export function exitCodeForStatus(status: 'completed' | 'failed' | 'cancelled' | 'waiting_input'): ExitCode {
  return status === 'completed' || status === 'waiting_input' ? EXIT.OK : EXIT.FAILED;
}
