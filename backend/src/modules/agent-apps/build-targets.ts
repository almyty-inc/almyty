import { DistributionTarget } from '../../entities/agent-app-distribution.entity';

/**
 * What each build target actually needs, and where it can be produced.
 *
 * The honest capability matrix, and it is less restrictive than the
 * usual "macOS needs a Mac" shorthand suggests.
 *
 * A single compiled executable DOES cross-compile to macOS from Linux:
 * `bun build --compile --target=bun-darwin-arm64` produces a working
 * darwin binary, and rcodesign signs and notarises it from Linux via
 * the App Store Connect API without Apple's own tooling. So terminal
 * apps and standalone binaries reach macOS users, signed, with no Mac
 * in the pipeline at all.
 *
 * The desktop app reaches macOS from Linux too, once you stop insisting
 * on a .dmg. Apple's notary service accepts a zipped .app and Gatekeeper
 * is satisfied by it, so the disk image is presentation rather than a
 * requirement, and dropping it removes hdiutil from the pipeline. A .app
 * bundle is a directory with a plist and a binary, which @electron/
 * packager will assemble anywhere. Native modules would still force a
 * Mac, but this shell has none: it renders a page we already serve.
 *
 * A .dmg is also reachable from Linux, so it is offered as a choice
 * rather than a reason to buy a Mac: xorrisofs -hfsplus (or the older
 * genisoimage -apple) writes an image macOS will mount, and
 * libdmg-hfsplus produces a UDIF one. The zip stays the default because
 * it is the path Apple's own notary service documents and the one with
 * the fewest moving parts; the disk image is what you pick when you
 * want the drag-to-Applications window.
 *
 * None of this is as well trodden as renting a Mac runner, so the
 * honest position is that it works and deserves verification per
 * toolchain, not that it is risk-free. A macOS build host stays
 * supported for anyone who wants the conventional route.
 *
 * Signing needs the customer's own identity. We can do it for them when
 * they upload one, the way every CI service does, but an unsigned
 * artifact is still a real artifact: on Linux it is normal, on Windows
 * it warns, and on macOS Gatekeeper refuses until the user clears the
 * quarantine flag by hand.
 */

/**
 * Where a build can execute.
 *
 * `any` means it cross-compiles, so a Linux container is enough.
 * `macos` means it genuinely needs Apple hardware.
 */
export type BuildHost = 'any' | 'macos';

export type SigningKind = 'none' | 'authenticode' | 'apple';

/**
 * How a macOS build is packaged.
 *
 * `zip` is a zipped .app: what Apple's notary service documents, and
 * buildable anywhere. `dmg` is a mountable disk image, which gives the
 * familiar drag-to-Applications window and can still be produced on
 * Linux with xorrisofs -hfsplus or libdmg-hfsplus.
 */
export type MacPackaging = 'zip' | 'dmg';

export const MAC_PACKAGING: Record<MacPackaging, { label: string; extension: string; note: string }> = {
  zip: {
    label: 'Zipped app',
    extension: 'zip',
    note: 'Fewest moving parts, and the format Apple documents for notarisation.',
  },
  dmg: {
    label: 'Disk image',
    extension: 'dmg',
    note: 'The familiar drag-to-Applications window. Built with xorrisofs on Linux, so verify the first one opens before sending it out.',
  },
};

export interface BuildPlatform {
  /** Stable id used in URLs and on the artifact. */
  id: string;
  label: string;
  /** Where the build itself must execute. */
  host: BuildHost;
  signing: SigningKind;
  /** What a user sees if we hand them this artifact unsigned. */
  unsignedConsequence: string;
  extension: string;
}

export const BUILD_PLATFORMS: Record<string, BuildPlatform> = {
  'linux-x64': {
    id: 'linux-x64',
    label: 'Linux (x64)',
    host: 'any',
    signing: 'none',
    // Linux has no code-signing expectation; unsigned is simply normal.
    unsignedConsequence: 'Runs normally. Linux does not expect signed binaries.',
    extension: 'AppImage',
  },
  'linux-arm64': {
    id: 'linux-arm64',
    label: 'Linux (arm64)',
    host: 'any',
    signing: 'none',
    unsignedConsequence: 'Runs normally. Linux does not expect signed binaries.',
    extension: 'AppImage',
  },
  'windows-x64': {
    id: 'windows-x64',
    label: 'Windows (x64)',
    host: 'any',
    signing: 'authenticode',
    unsignedConsequence:
      'Windows shows a SmartScreen warning the first time. Users can continue past it, which is usually acceptable inside a company and rarely acceptable for a public download.',
    extension: 'exe',
  },
  'macos-arm64': {
    id: 'macos-arm64',
    label: 'macOS (Apple silicon)',
    // Cross-compiles for a single executable; only the Electron desktop
    // target needs a Mac, which is decided per target below.
    host: 'any',
    signing: 'apple',
    unsignedConsequence:
      'macOS refuses to open it. The user has to right-click and choose Open, or clear the quarantine flag from a terminal, which most people will not do.',
    // A zipped .app rather than a disk image: the notary service accepts
    // it, Gatekeeper accepts it, and it needs no Apple tooling to make.
    extension: 'zip',
  },
  'macos-x64': {
    id: 'macos-x64',
    label: 'macOS (Intel)',
    host: 'any',
    signing: 'apple',
    unsignedConsequence:
      'macOS refuses to open it. The user has to right-click and choose Open, or clear the quarantine flag from a terminal, which most people will not do.',
    extension: 'zip',
  },
};

/** Platforms each target can be produced for. */
export const TARGET_PLATFORMS: Partial<Record<DistributionTarget, string[]>> = {
  // A terminal app is a single compiled executable with no window, no
  // webview and nothing to notarise, so it cross-compiles cleanly.
  [DistributionTarget.TUI]: ['linux-x64', 'linux-arm64', 'windows-x64', 'macos-arm64', 'macos-x64'],
  [DistributionTarget.BINARY]: [
    'linux-x64',
    'linux-arm64',
    'windows-x64',
    'macos-arm64',
    'macos-x64',
  ],
  // Desktop is an Electron shell. Each platform needs its own packaging
  // step, but none of them needs Apple hardware: the macOS artifact is
  // a zipped .app rather than a .dmg.
  [DistributionTarget.DESKTOP]: ['linux-x64', 'windows-x64', 'macos-arm64', 'macos-x64'],
};

export function isBuildable(target: DistributionTarget | string): boolean {
  return Array.isArray(TARGET_PLATFORMS[target as DistributionTarget]);
}

export function platformsFor(target: DistributionTarget | string): BuildPlatform[] {
  return (TARGET_PLATFORMS[target as DistributionTarget] ?? []).map((id) => BUILD_PLATFORMS[id]);
}

/**
 * Whether this deployment can build for a platform at all.
 *
 * A macOS artifact needs a macOS build host. Deployments without one
 * should say so plainly rather than queueing a job that will fail
 * twenty minutes later, or quietly producing a Linux binary the
 * operator did not ask for.
 */
/**
 * Whether this deployment can produce the artifact.
 *
 * Nothing requires Apple hardware as configured: executables
 * cross-compile through bun, the desktop app ships as a zipped .app
 * rather than a .dmg, and rcodesign signs and notarises both from
 * Linux. A macOS build host is still honoured when one is available,
 * because it is the conventional route and the only way to produce a
 * .dmg, but it is an option rather than a prerequisite.
 */
export function canBuildHere(
  platformId: string,
  _target: DistributionTarget | string,
  _available: { macos?: boolean } = {},
): { ok: boolean; reason: string | null } {
  const platform = BUILD_PLATFORMS[platformId];
  if (!platform) return { ok: false, reason: 'Unknown platform.' };
  return { ok: true, reason: null };
}

/** Credential a platform needs before we can sign for the customer. */
export interface SigningRequirement {
  kind: SigningKind;
  /** What the operator has to provide, in their words. */
  needs: string[];
  note: string;
}

export const SIGNING_REQUIREMENTS: Record<SigningKind, SigningRequirement | null> = {
  none: null,
  authenticode: {
    kind: 'authenticode',
    needs: ['A code-signing certificate (.pfx) and its password'],
    note: 'Stored in your credential vault, encrypted at rest, and used only inside the build.',
  },
  apple: {
    kind: 'apple',
    needs: [
      'A Developer ID Application certificate (.p12) and its password',
      'An App Store Connect API key, for notarisation',
    ],
    // Both steps run on Linux via rcodesign, so uploading these is
    // enough regardless of what the build host is.
    note: 'Stored in your credential vault, encrypted at rest, and used only inside the build. Notarisation is what stops macOS refusing to open the app.',
  },
};

export function signingRequirementFor(platformId: string): SigningRequirement | null {
  const platform = BUILD_PLATFORMS[platformId];
  if (!platform) return null;
  return SIGNING_REQUIREMENTS[platform.signing];
}

/**
 * A plain description of what the operator will get.
 *
 * Written to be readable before the build starts, because the moment
 * to learn that macOS will refuse to open your app is before you send
 * the link to two hundred people, not after.
 */
export function describeOutcome(
  platformId: string,
  willBeSigned: boolean,
  macPackaging: MacPackaging = 'zip',
): { artifact: string; caveat: string | null } {
  const platform = BUILD_PLATFORMS[platformId];
  if (!platform) return { artifact: 'Unknown platform', caveat: null };

  // Only macOS has a packaging choice; everywhere else the extension is
  // simply what that platform expects.
  const extension = platformId.startsWith('macos-')
    ? MAC_PACKAGING[macPackaging].extension
    : platform.extension;
  const artifact = `${platform.label} .${extension}`;
  if (platform.signing === 'none' || willBeSigned) return { artifact, caveat: null };
  return { artifact, caveat: platform.unsignedConsequence };
}

/**
 * The file extension an artifact should carry.
 *
 * Depends on the target as well as the platform, which the platform
 * table alone cannot express. A terminal app is a single executable:
 * bare on unix, .exe on Windows. Only the desktop app is a bundle, and
 * only that one is zipped or turned into a disk image.
 *
 * Getting this wrong is not cosmetic. A Mach-O executable named .zip
 * will not open when double-clicked, browsers will try to expand it,
 * and the person who downloaded it has no way to tell what went wrong.
 */
export function artifactExtension(
  target: DistributionTarget | string,
  platformId: string,
  macPackaging: MacPackaging = 'zip',
): string | null {
  const isWindows = platformId.startsWith('windows-');
  const isMac = platformId.startsWith('macos-');

  if (target === DistributionTarget.DESKTOP) {
    if (isWindows) return 'exe';
    if (isMac) return MAC_PACKAGING[macPackaging].extension;
    return 'AppImage';
  }

  // Terminal apps and standalone binaries are one executable file.
  // Unix has no extension for that; Windows needs .exe to run it.
  return isWindows ? 'exe' : null;
}

/** Filename for an artifact, given the app's name. */
export function artifactFilename(
  slug: string,
  target: DistributionTarget | string,
  platformId: string,
  macPackaging: MacPackaging = 'zip',
): string {
  const extension = artifactExtension(target, platformId, macPackaging);
  const base = `${slug}-${platformId}`;
  return extension ? `${base}.${extension}` : base;
}
