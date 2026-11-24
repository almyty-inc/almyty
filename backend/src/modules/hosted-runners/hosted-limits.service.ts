import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { AuditAction, AuditResource } from '../../entities/audit-log.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { HostedRunnersService } from './hosted-runners.service';
import { formatUsd } from './hosted-capacity.provider';

/** The limits an organization may lower for itself from the Hosted tab. */
export const OWN_LIMIT_FIELDS = ['maxConcurrentRunners', 'maxWorkspaces', 'monthlyCeilingUsd'] as const;
export type OwnLimitField = (typeof OWN_LIMIT_FIELDS)[number];
/** Null: no number (no limit on the plan; on its own row, follow the plan). */
export type OwnLimits = Record<OwnLimitField, number | null>;

export interface OwnLimitsView {
  /** False where own limits do not apply (no plan on this install). */
  available: boolean;
  /** The plan's limits, before the organization's own. */
  plan: OwnLimits;
  /** The organization's own lower limits; null where it follows the plan. */
  own: OwnLimits;
}

const NONE: OwnLimits = { maxConcurrentRunners: null, maxWorkspaces: null, monthlyCeilingUsd: null };

function limitPhrase(field: OwnLimitField, n: number): string {
  if (field === 'maxConcurrentRunners') return `${n} machine${n === 1 ? '' : 's'} running at once`;
  if (field === 'maxWorkspaces') return `${n} workspace${n === 1 ? '' : 's'} kept`;
  return `${formatUsd(n)} a month beyond the included hours`;
}

function asNumber(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null;
}

/**
 * An organization's own hosted limits (`settings.hostedCapacity`, read by
 * the plan capacity in `ee`): owners and admins may lower the machines
 * running at once, the workspaces kept and the monthly spending limit, never
 * raise one above the plan's, because the machines are the install's. Each
 * change goes on the audit trail.
 */
@Injectable()
export class HostedLimitsService {
  constructor(
    private readonly hosted: HostedRunnersService,
    private readonly dataSource: DataSource,
    @Optional() private readonly auditLog?: AuditLogService,
  ) {}

  private async ownRow(organizationId: string): Promise<Record<string, unknown>> {
    const rows = await this.dataSource.query(`SELECT settings FROM organizations WHERE id = $1`, [organizationId]);
    const own = rows?.[0]?.settings?.hostedCapacity;
    return own && typeof own === 'object' ? own : {};
  }

  private async planLimits(organizationId: string): Promise<OwnLimits | null> {
    const cap = await this.hosted.planLimitsFor(organizationId);
    if (!cap || cap.hostedEnvironments === false) return null;
    return {
      maxConcurrentRunners: cap.maxConcurrentRunners ?? null,
      maxWorkspaces: cap.maxWorkspaces ?? null,
      monthlyCeilingUsd: cap.monthlyCeilingUsd ?? null,
    };
  }

  async view(organizationId: string): Promise<OwnLimitsView> {
    const plan = await this.planLimits(organizationId);
    if (!plan) return { available: false, plan: { ...NONE }, own: { ...NONE } };
    const row = await this.ownRow(organizationId);
    const own = { ...NONE };
    for (const f of OWN_LIMIT_FIELDS) own[f] = asNumber(row[f]);
    return { available: true, plan, own };
  }

  /**
   * Replace the organization's own limits with `input`: a field left out or
   * null follows the plan. Refuses a number above the plan's limit. Other
   * own numbers set elsewhere (monthlyCeilingHours) are kept.
   */
  async set(
    organizationId: string,
    actor: { userId?: string; ipAddress?: string },
    input: Partial<Record<OwnLimitField, number | null>>,
  ): Promise<OwnLimitsView> {
    const plan = await this.planLimits(organizationId);
    if (!plan) throw new BadRequestException('Your plan has no hosted machine limits to lower.');
    const next: OwnLimits = { ...NONE };
    for (const f of OWN_LIMIT_FIELDS) {
      const raw = input[f];
      if (raw === undefined || raw === null) continue;
      const n = asNumber(raw);
      if (n === null) throw new BadRequestException(`${f} must be a number of 0 or more.`);
      const most = plan[f];
      if (most !== null && n > most) {
        throw new BadRequestException(`Your plan allows at most ${limitPhrase(f, most)}. You can only lower it.`);
      }
      next[f] = n;
    }

    const row = await this.ownRow(organizationId);
    const before = { ...NONE };
    for (const f of OWN_LIMIT_FIELDS) before[f] = asNumber(row[f]);
    const merged: Record<string, unknown> = { ...row };
    for (const f of OWN_LIMIT_FIELDS) {
      if (next[f] === null) delete merged[f];
      else merged[f] = next[f];
    }
    // Only the hostedCapacity key changes: the rest of the settings stay as they are.
    if (Object.keys(merged).length === 0) {
      await this.dataSource.query(`UPDATE organizations SET settings = COALESCE(settings, '{}'::jsonb) - 'hostedCapacity' WHERE id = $1`, [organizationId]);
    } else {
      await this.dataSource.query(
        `UPDATE organizations SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{hostedCapacity}', $2::jsonb, true) WHERE id = $1`,
        [organizationId, JSON.stringify(merged)],
      );
    }

    const changes = OWN_LIMIT_FIELDS.filter((f) => before[f] !== next[f]).map((f) => ({ field: f, from: before[f], to: next[f] }));
    if (changes.length > 0) {
      void this.auditLog
        ?.log({
          organizationId,
          userId: actor.userId,
          action: AuditAction.UPDATE,
          resourceType: AuditResource.ORGANIZATION,
          resourceId: organizationId,
          resourceName: 'Hosted machine limits',
          changes,
          details: { setting: 'hostedCapacity', plan },
          ipAddress: actor.ipAddress,
        })
        .catch(() => undefined);
    }
    return { available: true, plan, own: next };
  }
}
