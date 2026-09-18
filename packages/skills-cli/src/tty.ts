/**
 * Whether this process may prompt, and whether it may colour.
 *
 * `install` used to decide interactivity from `process.stdin.isTTY`
 * alone. That is true inside most CI runners' pseudo-terminals, so a
 * scripted install could stop dead on a multi-select picker nobody was
 * there to answer. Both streams and the CI marker have to agree before
 * a prompt is allowed.
 */

/** Whether both stdio streams are terminals. A test seam. */
export interface TtyState {
  stdin: boolean;
  stdout: boolean;
}

function currentTty(): TtyState {
  return {
    stdin: Boolean(process.stdin.isTTY),
    stdout: Boolean(process.stdout.isTTY),
  };
}

export function isInteractive(
  env: NodeJS.ProcessEnv = process.env,
  tty: TtyState = currentTty(),
): boolean {
  if (env.ALMYTY_NON_INTERACTIVE === '1') return false;
  if (env.CI && env.CI !== 'false' && env.CI !== '0') return false;
  return tty.stdin && tty.stdout;
}

/**
 * Whether decoration is wanted. Honours NO_COLOR (any value) and
 * FORCE_COLOR, in that order of surprise — see https://no-color.org.
 * The prompt library reads the same variables, so setting NO_COLOR
 * gives a plain picker rather than a half-coloured one.
 */
export function useColor(
  env: NodeJS.ProcessEnv = process.env,
  tty: TtyState = currentTty(),
): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0') return true;
  return tty.stdout;
}
