import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RetentionPolicy } from '../../entities/retention-policy.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuditAction, AuditResource } from '../../entities/audit-log.entity';
import { UpdateRetentionPolicyDto } from './dto/update-retention-policy.dto';

const DAY_FIELDS = [
  'agentRunsDays',
  'conversationsDays',
  'requestLogsDays',
  'usageMetricsDays',
  'auditLogDays',
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
      agentRunsDays: null,
      conversationsDays: null,
      requestLogsDays: null,
      usageMetricsDays: null,
      auditLogDays: null,
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
