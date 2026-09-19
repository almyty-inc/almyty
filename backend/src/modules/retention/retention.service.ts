import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RetentionPolicy } from '../../entities/retention-policy.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuditAction, AuditResource } from '../../entities/audit-log.entity';
import { UpdateRetentionPolicyDto } from './dto/update-retention-policy.dto';

// Every nullable day column on RetentionPolicy. The sweep reads each one
// (retention-sweep.service.ts), so a column missing from this list is a
// number the settings form accepts, returns 200 for, and never stores --
// which is exactly what happened to toolExecutionsDays and
// notificationsDays: both had a migration, an entity column, a DTO field
// and a sweep branch, and no way to be set.
const DAY_FIELDS = [
  'agentRunsDays',
  'conversationsDays',
  'requestLogsDays',
  'usageMetricsDays',
  'auditLogDays',
  'toolExecutionsDays',
  'notificationsDays',
] as const;

@Injectable()
export class RetentionService {
  constructor(
    @InjectRepository(RetentionPolicy)
    private readonly policyRepository: Repository<RetentionPolicy>,
    private readonly auditLogService: AuditLogService,
  ) {}

  /**
   * Returns the org's policy, or the documented default (everything kept
   * forever) without creating a row.
   */
  async getPolicy(organizationId: string): Promise<RetentionPolicy> {
    const existing = await this.policyRepository.findOne({
      where: { organizationId },
    });
    if (existing) return existing;

    const defaults = this.policyRepository.create({
      organizationId,
      enabled: true,
      ...Object.fromEntries(DAY_FIELDS.map((field) => [field, null])),
    });
    return defaults;
  }

  /** Create-or-update the org's policy (one row per org). */
  async upsertPolicy(
    organizationId: string,
    dto: UpdateRetentionPolicyDto,
    actorUserId?: string,
  ): Promise<RetentionPolicy> {
    let policy = await this.policyRepository.findOne({
      where: { organizationId },
    });

    const changes: { field: string; from: any; to: any }[] = [];
    if (!policy) {
      policy = this.policyRepository.create({ organizationId, enabled: true });
    }

    if (dto.enabled !== undefined && dto.enabled !== policy.enabled) {
      changes.push({ field: 'enabled', from: policy.enabled, to: dto.enabled });
      policy.enabled = dto.enabled;
    }
    for (const field of DAY_FIELDS) {
      const next = dto[field];
      if (next === undefined) continue;
      const prev = policy[field] ?? null;
      if (prev !== next) {
        changes.push({ field, from: prev, to: next });
      }
      policy[field] = next;
    }

    const saved = await this.policyRepository.save(policy);

    if (changes.length > 0) {
      await this.auditLogService.log({
        organizationId,
        userId: actorUserId,
        action: AuditAction.UPDATE,
        resourceType: AuditResource.ORGANIZATION,
        resourceId: organizationId,
        resourceName: 'retention_policy',
        changes,
      });
    }

    return saved;
  }
}
