import { randomBytes } from 'crypto';
import { Injectable, Logger, Optional, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import type { ApiKey } from '../../entities/api-key.entity';
import { Environment } from '../../entities/environment.entity';
import { HostedModelToken, HostedModelTokenRevokeReason } from '../../entities/hosted-model-token.entity';
import { HostedRunner } from '../../entities/hosted-runner.entity';
import { User } from '../../entities/user.entity';
import { Workspace, WorkspaceStatus } from '../../entities/workspace.entity';
import { AuditAction, AuditResource } from '../../entities/audit-log.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { hasEffectiveMembership } from '../../common/authorization/membership';
import { sha256 } from './enrollment.service';
import { HostedRunnerSettingsService } from './hosted-runner-settings';
import {
  HOSTED_MODEL_TOKEN_PREFIX,
  HostedModelAttribution,
  HostedModelTokens,
  hostedAttributionOf,
  isHostedModelToken,
} from './hosted-model-token.contract';

/** The bytes of randomness in a pod-scoped model token (as in an enrollment token). */
const TOKEN_BYTES = 32;

const TERMINAL = ['torn_down', 'orphaned', 'failed'];

/**
 * The pod-scoped model token (Decision 6): how a coding CLI in a hosted
 * pod calls a model without anybody's login or a vendor key.
 *
 * The reconcile loop mints one at every pod start (`mint`) and writes it
 * into the pod's Secret, from where the pod's environment carries it as
 * ANTHROPIC_API_KEY / OPENAI_API_KEY next to ANTHROPIC_BASE_URL /
 * OPENAI_BASE_URL pointing at almyty. Only the sha256 is stored. It is
 * bound to one hosted runner (so one workspace, environment and
 * organization) and acts as the workspace's owner, so it reaches exactly
 * the agents and model providers the owner may run, under the owner's and
 * the organization's budgets. It is accepted by the model endpoints only
 * (HOSTED_MODEL_TOKENS is injected there and nowhere else), lives at most
 * `modelAccess.tokenTtlMinutes`, and is revoked the moment the loop stops
 * the pod, tears it down, or the owner leaves.
 */
@Injectable()
export class HostedModelTokenService implements HostedModelTokens {
  private readonly logger = new Logger(HostedModelTokenService.name);

  constructor(
    @InjectRepository(HostedModelToken) private readonly tokens: Repository<HostedModelToken>,
    @InjectRepository(HostedRunner) private readonly hostedRunners: Repository<HostedRunner>,
    @InjectRepository(Workspace) private readonly workspaces: Repository<Workspace>,
    @InjectRepository(Environment) private readonly environments: Repository<Environment>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly settings: HostedRunnerSettingsService,
    @Optional() private readonly auditLog?: AuditLogService,
  ) {}

  /** A fresh token for the pod about to start; any earlier one of this hosted runner stops working. */
  async mint(
    hr: Pick<HostedRunner, 'id' | 'organizationId' | 'environmentId' | 'workspaceId'>,
    ownerUserId: string,
    now = new Date(),
    previous: HostedModelTokenRevokeReason = 'replaced',
  ): Promise<string> {
    await this.revoke(hr.id, previous, now);
    const token = `${HOSTED_MODEL_TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
    const expiresAt = this.expiryFrom(now);
    const inserted = await this.tokens.insert({
      organizationId: hr.organizationId,
      hostedRunnerId: hr.id,
      environmentId: hr.environmentId,
      workspaceId: hr.workspaceId,
      ownerUserId,
      tokenHash: sha256(token),
      expiresAt,
      revokedAt: null,
      revokedReason: null,
      lastUsedAt: null,
    });
    await this.audit(hr.organizationId, ownerUserId, AuditAction.HOSTED_MODEL_TOKEN_ISSUED, hr.id, {
      tokenId: inserted.identifiers?.[0]?.id ?? null,
      environmentId: hr.environmentId,
      workspaceId: hr.workspaceId,
      expiresAt: expiresAt.toISOString(),
    });
    return token;
  }
  /**
   * A running pod trades its current token for a fresh one before it
   * expires (POST /runners/hosted/model-token). Only the current token of
   * a pod that is still running is accepted, exactly as on the model
   * endpoints; the old one stops working at once.
   */
  async renew(token: string | null | undefined, now = new Date()): Promise<{ token: string; expiresAt: Date }> {
    const key = await this.authenticate(token, now);
    const a = hostedAttributionOf(key);
    if (!key || !a) throw new UnauthorizedException('This pod token is not valid');
    const hr = { id: a.hostedRunnerId, organizationId: key.organizationId, environmentId: a.environmentId, workspaceId: a.workspaceId };
    const next = await this.mint(hr, key.userId as string, now, 'renewed');
    const expiresAt = new Date(now.getTime() + this.settings.minutes(this.settings.current.modelAccess.tokenTtlMinutes));
    return { token: next, expiresAt };
  }

  /** When a token minted now expires. */
  expiryFrom(now = new Date()): Date {
    return new Date(now.getTime() + this.settings.minutes(this.settings.current.modelAccess.tokenTtlMinutes));
  }

  /** Stop every live token of a hosted runner. Idempotent. */
  async revoke(hostedRunnerId: string, reason: HostedModelTokenRevokeReason, now = new Date()): Promise<number> {
    const result = await this.tokens.update({ hostedRunnerId, revokedAt: IsNull() }, { revokedAt: now, revokedReason: reason });
    const count = result.affected ?? 0;
    if (count > 0 && reason !== 'replaced' && reason !== 'renewed') {
      const hr = await this.hostedRunners.findOne({ where: { id: hostedRunnerId }, select: { id: true, organizationId: true, environmentId: true, workspaceId: true } });
      if (hr) await this.audit(hr.organizationId, null, AuditAction.HOSTED_MODEL_TOKEN_REVOKED, hr.id, { reason, count, environmentId: hr.environmentId, workspaceId: hr.workspaceId });
    }
    return count;
  }

  async authenticate(token: string | null | undefined, now = new Date()): Promise<ApiKey | null> {
    if (!isHostedModelToken(token)) return null;
    const refused = new UnauthorizedException('This pod token is not valid');
    if (!this.settings.enabled()) throw refused;
    const row = await this.tokens.findOne({ where: { tokenHash: sha256(token) } });
    if (!row || row.revokedAt || row.expiresAt.getTime() <= now.getTime()) throw refused;

    // The pod it was minted for must still be the one running.
    const hr = await this.hostedRunners.findOne({ where: { id: row.hostedRunnerId, organizationId: row.organizationId } });
    if (!hr || TERMINAL.includes(hr.state) || hr.desired?.replicas !== 1 || hr.desired?.teardownRequested || hr.workspaceId !== row.workspaceId) throw refused;
    const workspace = await this.workspaces.findOne({ where: { id: row.workspaceId, organizationId: row.organizationId } });
    if (!workspace || workspace.status !== WorkspaceStatus.ACTIVE || workspace.ownerUserId !== row.ownerUserId) throw refused;
    const env = await this.environments.findOne({ where: { id: row.environmentId, organizationId: row.organizationId } });
    if (!env) throw refused;

    // It acts as the workspace's owner, who must still be an active member.
    const user = await this.users.findOne({ where: { id: row.ownerUserId }, relations: { organizationMemberships: true } });
    if (!user || !user.isActive || !hasEffectiveMembership(user.organizationMemberships, row.organizationId)) throw refused;

    await this.touch(row, now);
    const attribution: HostedModelAttribution = {
      tokenId: row.id,
      hostedRunnerId: row.hostedRunnerId,
      environmentId: row.environmentId,
      workspaceId: row.workspaceId,
    };
    // Shaped like an API key so the compat routes treat it as one: no
    // agent restriction, no gateway, no scopes, the owner as its user.
    return {
      id: row.id,
      organizationId: row.organizationId,
      userId: row.ownerUserId,
      user,
      agentId: null,
      gatewayId: null,
      scopes: null,
      isActive: true,
      expiresAt: row.expiresAt,
      lastUsedAt: row.lastUsedAt,
      isExpired: () => false,
      hostedModelToken: attribution,
    } as unknown as ApiKey;
  }

  /** lastUsedAt, at most once per `modelAccess.touchEverySeconds`. */
  private async touch(row: HostedModelToken, now: Date): Promise<void> {
    const every = this.settings.current.modelAccess.touchEverySeconds * 1000;
    if (row.lastUsedAt && now.getTime() - row.lastUsedAt.getTime() < every) return;
    await this.tokens.update({ id: row.id }, { lastUsedAt: now }).catch((err: any) => this.logger.warn(`Could not record pod token use: ${err?.message ?? err}`));
  }

  /**
   * One audit row, written before the caller goes on: issuing and revoking
   * a pod's model access is on the record by the time either returns. A
   * failed write is logged, never thrown (revocation must not fail on it).
   */
  private async audit(organizationId: string, userId: string | null, action: AuditAction, hostedRunnerId: string, details: Record<string, any>): Promise<void> {
    try {
      await this.auditLog?.log({
        organizationId,
        userId: userId ?? undefined,
        action,
        resourceType: AuditResource.HOSTED_RUNNER,
        resourceId: hostedRunnerId,
        details,
      });
    } catch (err: any) {
      this.logger.warn(`Could not audit ${action} for hosted runner ${hostedRunnerId}: ${err?.message ?? err}`);
    }
  }
}
