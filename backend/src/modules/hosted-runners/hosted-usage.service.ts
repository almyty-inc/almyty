import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { HostedRunner } from '../../entities/hosted-runner.entity';
import { RunnerUsageInterval } from '../../entities/runner-usage-interval.entity';
import { isUniqueViolation } from '../../common/utils/unique-violation';

/**
 * Runner-minutes, recorded from the provisioner's own observations.
 *
 * The reconcile processor is the only caller: it opens an interval when
 * it sees a pod ready and closes it when it sees the pod gone, so the
 * idle tail before the timeout is counted (it is a running pod) and a
 * pod's claims about itself never are. Both calls are idempotent: one
 * open interval per runner (a partial unique index), and closing an
 * already-closed one does nothing.
 */
@Injectable()
export class HostedUsageService {
  constructor(@InjectRepository(RunnerUsageInterval) private readonly intervals: Repository<RunnerUsageInterval>) {}

  async open(hr: HostedRunner, at: Date, agentId: string | null = null): Promise<void> {
    const existing = await this.intervals.findOne({ where: { hostedRunnerId: hr.id, endedAt: IsNull() } });
    if (existing) return;
    try {
      await this.intervals.insert({
        organizationId: hr.organizationId,
        hostedRunnerId: hr.id,
        environmentId: hr.environmentId,
        workspaceId: hr.workspaceId,
        agentId,
        resourceClass: hr.desired.resourceClass,
        startedAt: at,
        endedAt: null,
        reportedAt: null,
        meterIdentifier: null,
      });
    } catch (err) {
      // Another API pod opened it first.
      if (!isUniqueViolation(err)) throw err;
    }
  }

  async close(hostedRunnerId: string, at: Date): Promise<number> {
    const result = await this.intervals
      .createQueryBuilder()
      .update(RunnerUsageInterval)
      .set({ endedAt: () => `GREATEST("startedAt", :at)` })
      .setParameter('at', at)
      .where('"hostedRunnerId" = :id', { id: hostedRunnerId })
      .andWhere('"endedAt" IS NULL')
      .execute();
    return result.affected ?? 0;
  }

  /** Minutes per resource class an organization's pods ran in [from, to), open intervals counted up to `to`. */
  async minutesByClass(organizationId: string, from: Date, to: Date): Promise<Record<string, number>> {
    const rows: Array<{ resourceClass: string; seconds: string }> = await this.intervals
      .createQueryBuilder('i')
      .select('i."resourceClass"', 'resourceClass')
      .addSelect(
        `SUM(EXTRACT(EPOCH FROM (LEAST(COALESCE(i."endedAt", :to), :to) - GREATEST(i."startedAt", :from))))`,
        'seconds',
      )
      .where('i."organizationId" = :organizationId', { organizationId })
      .andWhere('i."startedAt" < :to', { to })
      .andWhere('(i."endedAt" IS NULL OR i."endedAt" > :from)', { from })
      .groupBy('i."resourceClass"')
      .getRawMany();
    const out: Record<string, number> = {};
    for (const row of rows) out[row.resourceClass] = Math.max(0, Number(row.seconds)) / 60;
    return out;
  }
}
