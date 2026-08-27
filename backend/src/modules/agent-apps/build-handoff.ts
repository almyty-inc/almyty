import { BUILD_PLATFORMS } from './build-targets';

/**
 * What to tell the people you hand an artifact to.
 *
 * Unsigned is a legitimate way to ship. Inside a company it is often
 * the only way anyone is going to ship this quarter, because a
 * Developer ID takes weeks of someone else's paperwork. What is not
 * legitimate is handing someone a download that refuses to open and
 * letting them work out why.
 *
 * So an unsigned build comes with the sentence its recipients need, and
 * where an operating system will simply refuse, the exact command that
 * clears it. Signed builds need none of this, which is the point of
 * signing and the reason the note says so.
 */

export interface Handoff {
  /** One line on what the recipient will meet. */
  summary: string;
  /** The command that gets past it, when one exists. */
  command: string | null;
  /** What the command is for, so nobody runs it blind. */
  commandNote: string | null;
}

/**
 * macOS quarantines anything downloaded from a browser and refuses to
 * open it unless it is signed *and* notarised. Removing the flag is
 * what a recipient would otherwise be told to do by a support article,
 * so it is better to hand it over than to make them search.
 */
const MACOS_QUARANTINE_NOTE =
  'Clearing the quarantine flag, which macOS sets on anything downloaded from a browser. Only run this on a file you know the origin of.';

export function handoffFor(platformId: string, signed: boolean, appName = 'the app'): Handoff {
  const platform = BUILD_PLATFORMS[platformId];

  if (!platform) {
    return { summary: 'Unknown platform.', command: null, commandNote: null };
  }

  if (platform.signing === 'none') {
    return {
      summary: 'Nothing to do. Linux does not expect signed binaries, so this just runs.',
      command: null,
      commandNote: null,
    };
  }

  if (signed) {
    return {
      summary: `Signed as you, so ${appName} opens without a warning.`,
      command: null,
      commandNote: null,
    };
  }

  if (platform.signing === 'authenticode') {
    return {
      summary:
        'Windows shows a SmartScreen warning the first time. Tell recipients to choose "More info", then "Run anyway". There is no command that skips this.',
      command: null,
      commandNote: null,
    };
  }

  // Apple, unsigned. The artifact runs once the flag is gone: an
  // unsigned build is still ad-hoc signed, which is what Apple silicon
  // requires to execute at all. Gatekeeper's download check is the
  // whole of the barrier.
  const isBundle = platform.extension === 'zip' || platform.extension === 'dmg';

  return {
    summary: isBundle
      ? 'macOS refuses to open this on download. Recipients either right-click and choose Open, or run the command below once after moving it to Applications.'
      : 'macOS refuses to run this on download. Recipients run the command below once, then it works normally.',
    command: isBundle
      ? `xattr -dr com.apple.quarantine "/Applications/${appName}.app"`
      : `xattr -d com.apple.quarantine ./${slugForCommand(appName)}`,
    commandNote: MACOS_QUARANTINE_NOTE,
  };
}

/** A filename a shell will accept without quoting gymnastics. */
function slugForCommand(appName: string): string {
  const cleaned = appName.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'app';
}
