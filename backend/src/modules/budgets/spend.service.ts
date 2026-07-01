import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AgentRun } from '../../entities/agent-run.entity';
import { SpendGranularity, normalizeGranularity } from './spend-period.util';

export interface SpendScope {
  organizationId: string;
  /** Narrow to one agent. Undefined/null = all agents in the org. */
  agentId?: string | null;
  /** Inclusive lower bound (period start). */
  from: Date;
  /** Exclusive upper bound. Defaults to "now" (open-ended). */
  to?: Date;
}

export interface SpendBucket {
  periodStart: string;
  spentCents: number;
  runCount: number;
}

export interface SpendByAgent {
  agentId: string;
  spentCents: number;
  runCount: number;
}

export interface SpendSummary {
  totalCents: number;
  timeseries: SpendBucket[];
  byAgent: SpendByAgent[];
}

/**
 * Read-side spend aggregation (T2.1). The single source of truth is
 * `AgentRun.totalCost`, which is stored in **dollars** — the per-run
 * cap converts it with `totalCost * 100 >= maxCostCents`, so we do the
 * same *100 here to return integer cents everywhere.
 */
@Injectable()
export class SpendService {
  constructor(
    @InjectRepository(AgentRun)
    private readonly runRepo: Repository<AgentRun>,
  ) {}

  private toCents(dollars: string | number | null | undefined): number {
    return Math.round(parseFloat(String(dollars ?? '0')) * 100);
  }

  /**
   * Period-to-date spend for a scope, in integer cents. Used by the
   * enforcement hook to compare against a budget's `limitCents`.
   */
  async periodToDateCents(scope: SpendScope): Promise<number> {
    const qb = this.runRepo
      .createQueryBuilder('run')
      .select('COALESCE(SUM(run.totalCost), 0)', 'total')
      .where('run.organizationId = :orgId', { orgId: scope.organizationId })
      .andWhere('run.createdAt >= :from', { from: scope.from });
    if (scope.to) qb.andWhere('run.createdAt < :to', { to: scope.to });
    if (scope.agentId) qb.andWhere('run.agentId = :agentId', { agentId: scope.agentId });

    const row = await qb.getRawOne<{ total: string }>();
    return this.toCents(row?.total);
  }

  /**
   * Spend over time + breakdown by agent for the Cost tab (T2.2).
   */
  async getSummary(
    organizationId: string,
    opts: { from: Date; to?: Date; granularity?: SpendGranularity | string },
  ): Promise<SpendSummary> {
    const bucket = normalizeGranularity(opts.granularity as string | undefined);

    const [totalCents, timeseries, byAgent] = await Promise.all([
      this.periodToDateCents({ organizationId, from: opts.from, to: opts.to }),
      this.timeseries(organizationId, opts.from, opts.to, bucket),
      this.byAgent(organizationId, opts.from, opts.to),
    ]);

    return { totalCents, timeseries, byAgent };
  }

  private async timeseries(
    organizationId: string,
    from: Date,
    to: Date | undefined,
    bucket: SpendGranularity,
  ): Promise<SpendBucket[]> {
    const qb = this.runRepo
      .createQueryBuilder('run')
      .select('date_trunc(:bucket, run.createdAt)', 'periodStart')
      .addSelect('COALESCE(SUM(run.totalCost), 0)', 'total')
      .addSelect('COUNT(*)', 'count')
      .where('run.organizationId = :orgId', { orgId: organizationId })
      .andWhere('run.createdAt >= :from', { from })
      .setParameter('bucket', bucket)
      .groupBy('date_trunc(:bucket, run.createdAt)')
      .orderBy('date_trunc(:bucket, run.createdAt)', 'ASC');
    if (to) qb.andWhere('run.createdAt < :to', { to });

    const rows = await qb.getRawMany<{ periodStart: Date; total: string; count: string }>();
    return rows.map((r) => ({
      periodStart: new Date(r.periodStart).toISOString(),
      spentCents: this.toCents(r.total),
      runCount: parseInt(r.count, 10),
    }));
  }

  private async byAgent(
    organizationId: string,
    from: Date,
    to: Date | undefined,
  ): Promise<SpendByAgent[]> {
    const qb = this.runRepo
      .createQueryBuilder('run')
      .select('run.agentId', 'agentId')
      .addSelect('COALESCE(SUM(run.totalCost), 0)', 'total')
      .addSelect('COUNT(*)', 'count')
      .where('run.organizationId = :orgId', { orgId: organizationId })
      .andWhere('run.createdAt >= :from', { from })
      .groupBy('run.agentId')
      .orderBy('COALESCE(SUM(run.totalCost), 0)', 'DESC')
      .limit(50);
    if (to) qb.andWhere('run.createdAt < :to', { to });

    const rows = await qb.getRawMany<{ agentId: string; total: string; count: string }>();
    return rows.map((r) => ({
      agentId: r.agentId,
      spentCents: this.toCents(r.total),
      runCount: parseInt(r.count, 10),
    }));
  }
}
