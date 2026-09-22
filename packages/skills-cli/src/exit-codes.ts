/**
 * Exit codes shared by every almyty CLI.
 *
 * Scripts need to tell "you are not logged in" apart from "that agent
 * does not exist" apart from "the run you asked for failed" without
 * grepping stderr. Every almyty CLI uses this same table, so
 * `almyty agents run x || case $? in 3) almyty login;; esac` behaves
 * the same whichever binary produced the code.
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
