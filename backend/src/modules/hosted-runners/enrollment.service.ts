import { createHash, randomBytes } from 'crypto';
import { Injectable, NotFoundException, Optional, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { HostedRunner } from '../../entities/hosted-runner.entity';
import { RunnerEnrollmentToken } from '../../entities/runner-enrollment-token.entity';
import { Runner, RunnerConfig, RunnerIsolationTier, RunnerRuntimeInfo, RunnerState } from '../../entities/runner.entity';
import { AuditAction, AuditResource } from '../../entities/audit-log.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { RunnerCredentialClaims, RunnerCredentialService } from '../runner/runner-credential';
import { HostedRunnerSettingsService } from './hosted-runner-settings';

/** The bytes of randomness in an enrollment token. */
const TOKEN_BYTES = 32;

export interface EnrollInput {
  token: string;
  runtimeInfo: RunnerRuntimeInfo;
  config?: Partial<RunnerConfig>;
}

export interface EnrollResult {
  runnerId: string;
  credential: string;
  expiresAt: Date;
  effectiveConfig: RunnerConfig;
  /** Where the runner holds its stream with the credential. */
  streamPath: string;
  renewPath: string;
}

export const HOSTED_STREAM_PATH = '/runners/hosted/stream';
export const HOSTED_RENEW_PATH = '/runners/hosted/credential';

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

const TERMINAL = ['torn_down', 'orphaned'];

/**
 * Enrollment: how a hosted runner pod gets a credential without anybody's
 * login. The reconcile processor mints a single-use token before every
 * start (`mint`), writes it into the pod's Secret through the adapter,
 * and the runner trades it once for a runner credential (`enroll`). The
 * credential names one runner and is refused everywhere but that
 * runner's own stream and renewal (RunnerCredentialGuard).
 */
@Injectable()
export class EnrollmentService {
  constructor(
    @InjectRepository(RunnerEnrollmentToken) private readonly tokens: Repository<RunnerEnrollmentToken>,
    @InjectRepository(HostedRunner) private readonly hostedRunners: Repository<HostedRunner>,
    @InjectRepository(Runner) private readonly runners: Repository<Runner>,
    private readonly credentials: RunnerCredentialService,
    private readonly settings: HostedRunnerSettingsService,
    @Optional() private readonly auditLog?: AuditLogService,
  ) {}

  /** A fresh token for one hosted runner; only its hash is stored. */
  async mint(hr: Pick<HostedRunner, 'id' | 'organizationId'>, now = new Date()): Promise<string> {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    await this.tokens.insert({
      organizationId: hr.organizationId,
      hostedRunnerId: hr.id,
      tokenHash: sha256(token),
      expiresAt: new Date(now.getTime() + this.settings.minutes(this.settings.current.enrollment.tokenTtlMinutes)),
      usedAt: null,
    });
    return token;
  }

  /**
   * Trade a token for a runner credential, once. The token is claimed in
   * one conditional UPDATE (unused, unexpired), so two pods presenting the
   * same token cannot both enroll. A token that is unknown, used or
   * expired gets the same 401.
   */
  async enroll(input: EnrollInput, now = new Date()): Promise<EnrollResult> {
    const refused = new UnauthorizedException('This enrollment token is not valid');
    if (!this.settings.enabled() || !input?.token || typeof input.token !== 'string') throw refused;
    const claimed: Array<{ hostedRunnerId: string; organizationId: string }> = await this.tokens.query(
      `UPDATE "runner_enrollment_tokens" SET "usedAt" = $2
        WHERE "tokenHash" = $1 AND "usedAt" IS NULL AND "expiresAt" > $2
        RETURNING "hostedRunnerId", "organizationId"`,
      [sha256(input.token), now],
    ).then((r: any) => (Array.isArray(r?.[0]) ? r[0] : r));
    const row = claimed?.[0];
    if (!row) throw refused;
    const hr = await this.hostedRunners.findOne({ where: { id: row.hostedRunnerId, organizationId: row.organizationId } });
    if (!hr || !hr.runnerId || TERMINAL.includes(hr.state) || hr.desired?.teardownRequested) throw refused;
    const runner = await this.runners.findOne({ where: { id: hr.runnerId, organizationId: hr.organizationId, kind: 'hosted' } });
    if (!runner) throw refused;

    const mount = this.settings.current.cluster.workspaceMountPath;
    // The pod is the sandbox, so the runner runs its work on the host
    // inside it, in the workspace volume only.
    const effectiveConfig: RunnerConfig = {
      denyPatterns: [],
      installBlocked: false,
      networkBlocked: false,
      ...(input.config ?? {}),
      defaultIsolation: RunnerIsolationTier.HOST,
      // One workspace per pod, one job at a time in it: the pod cannot ask
      // for more (the API also serialises jobs, WorkspaceLeaseService).
      maxConcurrent: 1,
      allowedCwdRoots: [mount],
    };
    await this.runners.update(
      { id: runner.id },
      { runtimeInfo: input.runtimeInfo ?? null, config: effectiveConfig, state: RunnerState.REGISTERED, lastHeartbeatAt: null },
    );
    const { token, expiresAt } = this.credentials.sign(
      { runnerId: runner.id, organizationId: hr.organizationId, hostedRunnerId: hr.id, actUserId: runner.ownerUserId },
      this.credentialTtlSeconds(),
    );
    void this.auditLog
      ?.log({
        organizationId: hr.organizationId,
        action: AuditAction.RUNNER_ENROLLED,
        resourceType: AuditResource.RUNNER,
        resourceId: runner.id,
        resourceName: runner.name,
        details: { hostedRunnerId: hr.id, environmentId: hr.environmentId, workspaceId: hr.workspaceId },
      })
      .catch(() => undefined);
    return { runnerId: runner.id, credential: token, expiresAt, effectiveConfig, streamPath: HOSTED_STREAM_PATH, renewPath: HOSTED_RENEW_PATH };
  }

  /** A new credential for a runner whose current one is still valid, while its hosted runner lives. */
  async renew(claims: RunnerCredentialClaims): Promise<{ credential: string; expiresAt: Date }> {
    const hr = await this.hostedRunners.findOne({ where: { id: claims.hostedRunnerId, organizationId: claims.organizationId } });
    if (!hr || hr.runnerId !== claims.runnerId || TERMINAL.includes(hr.state) || hr.desired?.teardownRequested) {
      throw new NotFoundException('runner not found');
    }
    const { token, expiresAt } = this.credentials.sign(claims, this.credentialTtlSeconds());
    return { credential: token, expiresAt };
  }

  private credentialTtlSeconds(): number {
    return this.settings.minutes(this.settings.current.enrollment.credentialTtlMinutes) / 1000;
  }
}
