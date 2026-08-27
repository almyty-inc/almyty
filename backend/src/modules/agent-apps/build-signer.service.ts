import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { promises as fs } from 'fs';
import { join } from 'path';

import { Credential, CredentialType } from '../../entities/credential.entity';
import { AppDistribution } from '../../entities/agent-app-distribution.entity';
import { BUILD_PLATFORMS, type SigningKind } from './build-targets';
import type { ToolchainRunner } from './build-toolchain';
import {
  APPLE_API_KEY_FILENAME,
  CERTIFICATE_FILENAME,
  SIGNING_TOOL,
  adhocSignArgs,
  appleNotarizeArgs,
  appleSignArgs,
  authenticodeSignArgs,
  describeSigningFailure,
  identityFromConfig,
  signingReadiness,
  type SigningOutcome,
} from './build-signing';

/** Where the certificate password is written, for the tool to read. */
const PASSWORD_FILENAME = 'certificate-password';

/**
 * Signing a built artifact as the customer.
 *
 * Deliberately never guesses which certificate to use. A distribution
 * names one, or the build stays unsigned and says so. Signing software
 * with an identity nobody chose is not a convenience.
 */
@Injectable()
export class BuildSignerService {
  constructor(
    @InjectRepository(Credential)
    private readonly credentials: Repository<Credential>,
    @InjectRepository(AppDistribution)
    private readonly distributions: Repository<AppDistribution>,
  ) {}

  /** What a platform needs signed, if anything. */
  kindFor(platformId: string): SigningKind {
    return BUILD_PLATFORMS[platformId]?.signing ?? 'none';
  }

  /**
   * Sign in place, or explain why not.
   *
   * Every failure here leaves the artifact intact and unsigned rather
   * than failing the build: an unsigned build that says it is unsigned
   * is still useful, and the operator is told what to fix.
   */
  async sign(params: {
    appId: string;
    target: string;
    platform: string;
    artifactPath: string;
    workDir: string;
    runner: ToolchainRunner;
  }): Promise<SigningOutcome> {
    const kind = this.kindFor(params.platform);
    if (kind === 'none') {
      return { signed: false, notarised: false, error: null, log: '' };
    }

    const distribution = await this.distributionFor(params.appId, params.target);
    const credential = await this.credentialFor(distribution);
    if (!credential) {
      // Shipping unsigned is a legitimate choice, and often the only
      // one available while a Developer ID is somewhere in Apple's
      // paperwork. Give the artifact the customer's own identifier
      // anyway, so it is not one of the world's many applications
      // called "Electron".
      const stamped = await this.stampIdentifier(kind, distribution, params);
      return {
        signed: false,
        notarised: false,
        error: 'No signing certificate is selected, so this ships unsigned.',
        log: stamped,
      };
    }

    const { identity, missing } = identityFromConfig(kind, credential.getDecryptedConfig());
    if (!identity) {
      return {
        signed: false,
        notarised: false,
        error: `That signing credential is missing ${missing.join(', ')}.`,
        log: '',
      };
    }

    const readiness = await signingReadiness(kind, params.runner);
    if (!readiness.ready) {
      return { signed: false, notarised: false, error: readiness.reason, log: '' };
    }

    const certificatePath = join(params.workDir, CERTIFICATE_FILENAME);
    const passwordPath = join(params.workDir, PASSWORD_FILENAME);

    try {
      // 0o600 because a build host runs other tenants' builds, and the
      // window between writing this and deleting it is a real window.
      await fs.writeFile(certificatePath, identity.certificate, { mode: 0o600 });
      await fs.writeFile(passwordPath, identity.certificatePassword, { mode: 0o600 });

      const bundleId = distribution?.configuration?.bundleId;

      return kind === 'apple'
        ? await this.signApple(identity, params, certificatePath, passwordPath, bundleId)
        : await this.signAuthenticode(identity, params, certificatePath);
    } finally {
      // Before the scratch directory is removed rather than relying on
      // it, so a failure to clean up the directory does not leave a
      // private key behind.
      await fs.rm(certificatePath, { force: true }).catch(() => undefined);
      await fs.rm(passwordPath, { force: true }).catch(() => undefined);
      await fs
        .rm(join(params.workDir, APPLE_API_KEY_FILENAME), { force: true })
        .catch(() => undefined);
    }
  }

  /**
   * Ad-hoc sign, so an unsigned artifact still identifies as the
   * customer's product.
   *
   * Best effort in every direction: only Apple platforms care, only
   * when a bundle id was set, and only when the tool is present. A
   * failure here changes nothing about the artifact that was already
   * going to ship.
   */
  private async stampIdentifier(
    kind: SigningKind,
    distribution: AppDistribution | null,
    params: { artifactPath: string; workDir: string; runner: ToolchainRunner },
  ): Promise<string> {
    const bundleId = distribution?.configuration?.bundleId;
    if (kind !== 'apple' || !bundleId) return '';

    const tool = SIGNING_TOOL.apple!;
    if (!(await params.runner.available(tool))) return '';

    const result = await params.runner.run(tool, adhocSignArgs(params.artifactPath, bundleId), {
      cwd: params.workDir,
    });
    return result.output;
  }

  private async signApple(
    identity: { appleApiKeyId?: string; appleApiIssuer?: string; appleApiKey?: string },
    params: { artifactPath: string; workDir: string; runner: ToolchainRunner },
    certificatePath: string,
    passwordPath: string,
    bundleId?: string,
  ): Promise<SigningOutcome> {
    const tool = SIGNING_TOOL.apple!;

    const signed = await params.runner.run(
      tool,
      appleSignArgs(params.artifactPath, certificatePath, passwordPath, bundleId),
      { cwd: params.workDir },
    );
    if (!signed.ok) {
      return {
        signed: false,
        notarised: false,
        error: describeSigningFailure('apple', signed),
        log: signed.output,
      };
    }

    // Signing satisfies "who made this". Notarisation satisfies "Apple
    // has seen this", which is the one Gatekeeper actually enforces on
    // a download, so a signed-but-unnotarised app still gets refused.
    const apiKeyPath = join(params.workDir, APPLE_API_KEY_FILENAME);
    await fs.writeFile(
      apiKeyPath,
      JSON.stringify({
        key_id: identity.appleApiKeyId,
        issuer_id: identity.appleApiIssuer,
        private_key: identity.appleApiKey,
      }),
      { mode: 0o600 },
    );

    const notarised = await params.runner.run(
      tool,
      appleNotarizeArgs(params.artifactPath, apiKeyPath),
      { cwd: params.workDir },
    );

    if (!notarised.ok) {
      // The signature is real and stays. Saying it is notarised when
      // Apple has not seen it is how someone ships an app that opens on
      // the machine that built it and nowhere else.
      return {
        signed: true,
        notarised: false,
        error:
          'Signed, but Apple did not accept it for notarisation, so macOS will still warn on download.',
        log: `${signed.output}\n${notarised.output}`,
      };
    }

    return {
      signed: true,
      notarised: true,
      error: null,
      log: `${signed.output}\n${notarised.output}`,
    };
  }

  private async signAuthenticode(
    identity: { certificatePassword: string },
    params: { artifactPath: string; workDir: string; runner: ToolchainRunner },
    certificatePath: string,
  ): Promise<SigningOutcome> {
    const tool = SIGNING_TOOL.authenticode!;
    const outputPath = `${params.artifactPath}.signed`;

    const result = await params.runner.run(
      tool,
      authenticodeSignArgs(
        params.artifactPath,
        certificatePath,
        identity.certificatePassword,
        outputPath,
      ),
      { cwd: params.workDir },
    );

    if (!result.ok) {
      await fs.rm(outputPath, { force: true }).catch(() => undefined);
      return {
        signed: false,
        notarised: false,
        error: describeSigningFailure('authenticode', result),
        log: result.output,
      };
    }

    // osslsigncode writes beside the input, so the signed copy replaces
    // the original and the caller reads one path either way.
    await fs.rename(outputPath, params.artifactPath);

    // Windows has no separate notarisation step; a timestamped
    // Authenticode signature is the whole of it.
    return { signed: true, notarised: true, error: null, log: result.output };
  }

  /**
   * The certificate this distribution names, if it names one.
   *
   * Only a code-signing credential in the same organization is
   * accepted, so an id copied from somewhere else resolves to nothing
   * rather than to another tenant's key.
   */
  private distributionFor(appId: string, target: string): Promise<AppDistribution | null> {
    return this.distributions.findOne({ where: { appId, target: target as any } });
  }

  private async credentialFor(distribution: AppDistribution | null): Promise<Credential | null> {
    const credentialId = distribution?.configuration?.signingCredentialId;
    if (!credentialId || typeof credentialId !== 'string') return null;

    return this.credentials.findOne({
      where: {
        id: credentialId,
        organizationId: distribution!.organizationId,
        type: CredentialType.CODE_SIGNING,
        isActive: true,
      },
    });
  }
}
