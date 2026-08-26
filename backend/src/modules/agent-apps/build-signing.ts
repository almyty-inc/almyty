import { SigningKind } from './build-targets';
import type { ToolchainResult, ToolchainRunner } from './build-toolchain';

/**
 * Signing an artifact with the customer's own identity.
 *
 * The certificate is theirs, so the signature is theirs: the app is
 * published by them, not by us, and an operating system that asks who
 * signed it gets their name. That is the whole point of the feature,
 * and it is why the private key has to reach a build container at all.
 *
 * Nothing here logs the certificate, the password, or an argument list
 * containing either. A build log is shown in a web page.
 */

/** What a signing run needs, once the vault has been read. */
export interface SigningIdentity {
  kind: SigningKind;
  /** The .p12 / .pfx, decoded. */
  certificate: Buffer;
  certificatePassword: string;
  /** Apple notarisation, which is separate from signing. */
  appleApiKeyId?: string;
  appleApiIssuer?: string;
  appleApiKey?: string;
}

export interface SigningOutcome {
  signed: boolean;
  /** Whether the artifact will open without a warning on the target OS. */
  notarised: boolean;
  /** A sentence for the operator when it did not work. */
  error: string | null;
  /**
   * The tool's own output, for the build log.
   *
   * Kept separate from `error` because it names the path the
   * certificate was written to, and the log is not shown in the panel.
   * Without it a signing failure is undiagnosable.
   */
  log: string;
}

/** The tool that signs for each platform family. */
export const SIGNING_TOOL: Record<SigningKind, string | null> = {
  none: null,
  apple: 'rcodesign',
  authenticode: 'osslsigncode',
};

/**
 * Where a secret is written for the length of one build.
 *
 * Both tools read the certificate from a path rather than from stdin,
 * so it has to touch a filesystem. It goes in the build's own scratch
 * directory, which is removed unconditionally, under a fixed name so
 * the caller can delete it without guessing.
 */
export const CERTIFICATE_FILENAME = 'signing-certificate.p12';
export const APPLE_API_KEY_FILENAME = 'notarisation-key.json';

/**
 * Arguments for signing a macOS artifact.
 *
 * `--p12-password-file` rather than `--p12-password`: an argument list
 * is visible in `ps` to every process on the host, and a build host
 * runs other tenants' builds.
 */
export function appleSignArgs(
  artifactPath: string,
  certificatePath: string,
  passwordFilePath: string,
  bundleId?: string,
): string[] {
  const args = [
    'sign',
    '--p12-file',
    certificatePath,
    '--p12-password-file',
    passwordFilePath,
    '--code-signature-flags',
    'runtime',
  ];

  // A bare executable has no Info.plist, so without this every
  // customer's binary identifies as whatever the compiler called it and
  // two different products are indistinguishable to the OS.
  if (bundleId) args.push('--binary-identifier', bundleId);

  args.push(artifactPath);
  return args;
}

/**
 * Arguments for submitting a signed macOS artifact to Apple.
 *
 * Signing alone is not enough: Gatekeeper checks for a notarisation
 * ticket, and without one the app is refused with a message about an
 * unidentified developer even though it is signed.
 */
export function appleNotarizeArgs(artifactPath: string, apiKeyPath: string): string[] {
  return ['notary-submit', '--api-key-file', apiKeyPath, '--staple', artifactPath];
}

/**
 * Arguments for signing a Windows executable.
 *
 * osslsigncode writes to a separate output file rather than in place,
 * so the caller moves the result over the original.
 */
export function authenticodeSignArgs(
  artifactPath: string,
  certificatePath: string,
  password: string,
  outputPath: string,
): string[] {
  return [
    'sign',
    '-pkcs12',
    certificatePath,
    '-pass',
    password,
    // A signature with no timestamp stops verifying the day the
    // certificate expires, which turns every shipped copy into a
    // warning rather than only new ones.
    '-t',
    'http://timestamp.digicert.com',
    '-in',
    artifactPath,
    '-out',
    outputPath,
  ];
}

/**
 * Whether this host can sign for a platform, and what is missing.
 *
 * Checked before the attempt so an operator is told the deployment
 * cannot sign, rather than being handed something described as signed
 * that no operating system agrees with.
 */
export async function signingReadiness(
  kind: SigningKind,
  runner: ToolchainRunner,
): Promise<{ ready: boolean; reason: string | null }> {
  const tool = SIGNING_TOOL[kind];
  if (!tool) return { ready: true, reason: null };

  if (await runner.available(tool)) return { ready: true, reason: null };
  return {
    ready: false,
    reason: `This deployment cannot sign for ${kind} because ${tool} is not installed on the build host.`,
  };
}

/**
 * What the vault holds, as a signing identity, or a sentence saying
 * what is missing.
 *
 * A half-filled credential is worse than none: it produces a build that
 * claims to be signed and is not. So every field a kind needs is
 * checked here rather than discovered by the tool.
 */
export function identityFromConfig(
  kind: SigningKind,
  config: Record<string, any> | null | undefined,
): { identity: SigningIdentity | null; missing: string[] } {
  if (kind === 'none') return { identity: null, missing: [] };
  if (!config) return { identity: null, missing: ['a signing certificate'] };

  const missing: string[] = [];
  const certificate = typeof config.certificate === 'string' ? config.certificate : '';
  const certificatePassword =
    typeof config.certificatePassword === 'string' ? config.certificatePassword : '';

  if (!certificate) missing.push('a signing certificate');
  if (!certificatePassword) missing.push('the certificate password');

  if (kind === 'apple') {
    if (!config.appleApiKeyId) missing.push('an App Store Connect key id');
    if (!config.appleApiIssuer) missing.push('an App Store Connect issuer id');
    if (!config.appleApiKey) missing.push('an App Store Connect private key');
  }

  if (missing.length) return { identity: null, missing };

  return {
    identity: {
      kind,
      certificate: Buffer.from(certificate, 'base64'),
      certificatePassword,
      appleApiKeyId: config.appleApiKeyId,
      appleApiIssuer: config.appleApiIssuer,
      appleApiKey: config.appleApiKey,
    },
    missing: [],
  };
}

/**
 * A signing result an operator can act on.
 *
 * The tool's own output is not passed through: it contains the argument
 * list, and on failure often the path to the certificate. The build log
 * is a web page.
 */
export function describeSigningFailure(kind: SigningKind, result: ToolchainResult): string {
  const tool = SIGNING_TOOL[kind] ?? 'the signing tool';

  // These are the two the operator can actually fix, and they are
  // indistinguishable from a generic exit code unless we look.
  const output = result.output.toLowerCase();
  if (output.includes('password') || output.includes('mac verify failure')) {
    return 'The certificate password was rejected. Check it and try again.';
  }
  if (output.includes('expired')) {
    return 'That signing certificate has expired. Upload a current one.';
  }
  return `${tool} could not sign the artifact. The certificate and password are stored, so this is worth retrying once the certificate is checked.`;
}
