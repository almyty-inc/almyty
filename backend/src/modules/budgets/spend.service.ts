import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AgentRun } from '../../entities/agent-run.entity';
import { AgentExecution } from '../../entities/agent-execution.entity';
import { SpendGranularity, normalizeGranularity } from './spend-period.util';
import { notOthersPrivateAgent } from '../monitoring/private-rows';

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

export interface SpendByTeam {
  /** Null for org-scoped agents that belong to no team. */
  teamId: string | null;
  spentCents: number;
  runCount: number;
}

export interface SpendSummary {
  totalCents: number;
  timeseries: SpendBucket[];
  byAgent: SpendByAgent[];
}

export interface SpendForecast {
  /** Projected spend for the next `periodsAhead` buckets, in cents. */
  projectedCents: number;
  /** Per-bucket slope (cents/period) from the least-squares fit. */
  perPeriodCents: number;
  periodsAhead: number;
  basis: 'linear' | 'insufficient-data';
}

/**
 * Read-side spend aggregation (T2.1). Cost is stored in **dollars** —
 * the per-run cap converts it with `totalCost * 100 >= maxCostCents`, so
 * we do the same *100 here to return integer cents everywhere.
 *
 * An agent spends money in one of two shapes and this service has to
 * cover both. An autonomous agent runs on the step processor and writes
 * `agent_runs`; a workflow agent runs on the pipeline engine and writes
 * `agent_executions` and never an AgentRun. Reading only `agent_runs`
 * meant every workflow agent showed nothing on the Cost tab, reported a
 * period-to-date of 0, could never trip `enforceForRun`, and never sent
 * a spend-alert email.
 *
 * Covered on the READ side, by unioning the two tables here, rather than
 * by having the pipeline engine write an AgentRun shell. A shell would
 * have to carry steps, limits, a conversation and a status enum the
 * workflow path has no meaning for; it would show up in every run list
 * and in `a2a-task.handler`'s queries, and the run reaper would sweep
 * it. This service already documents itself as the single read-side
 * aggregation point, so one place changes and every surface above it —
 * Cost tab, forecast, budget enforcement, alerts — is covered at once.
 */
@Injectable()
export class SpendService {
  constructor(
    @InjectRepository(AgentRun)
    private readonly runRepo: Repository<AgentRun>,
    @InjectRepository(AgentExecution)
    private readonly executionRepo: Repository<AgentExecution>,
  ) {}

  private toCents(dollars: string | number | null | undefined): number {
    return Math.round(parseFloat(String(dollars ?? '0')) * 100);
  }

  /**
   * Both spend tables have the same four columns this service needs
   * (organizationId, agentId, totalCost, createdAt), so each aggregation
   * runs the same query twice under a shared alias and merges. Missing
   * repo = the autonomous half only, which keeps a caller that predates
   * the workflow half working rather than throwing.
   */
  private spendSources(): Array<{ repo: Repository<any>; alias: string }> {
    const sources: Array<{ repo: Repository<any>; alias: string }> = [
      { repo: this.runRepo, alias: 'run' },
    ];
    if (this.executionRepo) sources.push({ repo: this.executionRepo, alias: 'run' });
    return sources;
  }

  /**
   * Period-to-date spend for a scope, in integer cents. Used by the
   * enforcement hook to compare against a budget's `limitCents`.
   *
   * Sums BOTH execution shapes. Reading only `agent_runs` meant a
   * workflow agent's budget could never trip, however much it spent.
   */
  async periodToDateCents(scope: SpendScope): Promise<number> {
    const totals = await Promise.all(
      this.spendSources().map(async ({ repo, alias }) => {
        const qb = repo
          .createQueryBuilder(alias)
          .select(`COALESCE(SUM(${alias}.totalCost), 0)`, 'total')
          .where(`${alias}.organizationId = :orgId`, { orgId: scope.organizationId })
          .andWhere(`${alias}.createdAt >= :from`, { from: scope.from });
        if (scope.to) qb.andWhere(`${alias}.createdAt < :to`, { to: scope.to });
        if (scope.agentId) qb.andWhere(`${alias}.agentId = :agentId`, { agentId: scope.agentId });

        const row = await qb.getRawOne<{ total: string }>();
        return this.toCents(row?.total);
      }),
    );
    return totals.reduce((a, b) => a + b, 0);
  }

  /**
   * Spend over time + breakdown by agent for the Cost tab (T2.2).
   *
   * `viewerId` is the calling user. The per-agent breakdown leaves out
   * another member's private agents, and every agent in `hiddenAgentIds`
   * (team agents outside the viewer's teams): a row names the agent and
   * its spend. A null viewer gets no private agent's row. The total and the
   * timeseries stay org-wide sums -- they are the org's spend, which the
   * org-wide budgets are measured against, and name no agent.
   */
  async getSummary(
    organizationId: string,
    opts: {
      from: Date;
      to?: Date;
      granularity?: SpendGranularity | string;
      viewerId: string | null;
      /** Agents the viewer may not see; their rows are left out of the breakdown. */
      hiddenAgentIds?: string[];
    },
  ): Promise<SpendSummary> {
    const bucket = normalizeGranularity(opts.granularity as string | undefined);

    const [totalCents, timeseries, byAgent] = await Promise.all([
      this.periodToDateCents({ organizationId, from: opts.from, to: opts.to }),
      this.timeseries(organizationId, opts.from, opts.to, bucket),
      this.byAgent(organizationId, opts.from, opts.to, opts.viewerId ?? null, opts.hiddenAgentIds ?? []),
    ]);

    return { totalCents, timeseries, byAgent };
  }

  private async timeseries(
    organizationId: string,
    from: Date,
    to: Date | undefined,
    bucket: SpendGranularity,
  ): Promise<SpendBucket[]> {
    const perSource = await Promise.all(
      this.spendSources().map(async ({ repo, alias }) => {
        const qb = repo
          .createQueryBuilder(alias)
          .select(`date_trunc(:bucket, ${alias}.createdAt)`, 'periodStart')
          .addSelect(`COALESCE(SUM(${alias}.totalCost), 0)`, 'total')
          .addSelect('COUNT(*)', 'count')
          .where(`${alias}.organizationId = :orgId`, { orgId: organizationId })
          .andWhere(`${alias}.createdAt >= :from`, { from })
          .setParameter('bucket', bucket)
          .groupBy(`date_trunc(:bucket, ${alias}.createdAt)`)
          .orderBy(`date_trunc(:bucket, ${alias}.createdAt)`, 'ASC');
        if (to) qb.andWhere(`${alias}.createdAt < :to`, { to });

        return qb.getRawMany<{ periodStart: Date; total: string; count: string }>();
      }),
    );

    // Merge the two shapes' buckets: a period with both an autonomous run
    // and a workflow execution is one bucket, not two.
    const merged = new Map<string, { spentCents: number; runCount: number }>();
    for (const rows of perSource) {
      for (const r of rows) {
        const key = new Date(r.periodStart).toISOString();
        const acc = merged.get(key) ?? { spentCents: 0, runCount: 0 };
        acc.spentCents += this.toCents(r.total);
        acc.runCount += parseInt(r.count, 10);
        merged.set(key, acc);
      }
    }

    return [...merged.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([periodStart, v]) => ({ periodStart, ...v }));
  }

  private async byAgent(
    organizationId: string,
    from: Date,
    to: Date | undefined,
    viewerId: string | null,
    hiddenAgentIds: string[],
  ): Promise<SpendByAgent[]> {
    const perSource = await Promise.all(
      this.spendSources().map(async ({ repo, alias }) => {
        const qb = repo
          .createQueryBuilder(alias)
          .select(`${alias}.agentId`, 'agentId')
          .addSelect(`COALESCE(SUM(${alias}.totalCost), 0)`, 'total')
          .addSelect('COUNT(*)', 'count')
          .where(`${alias}.organizationId = :orgId`, { orgId: organizationId })
          .andWhere(`${alias}.createdAt >= :from`, { from })
          .andWhere(notOthersPrivateAgent(`${alias}."agentId"`), { privateViewerId: viewerId })
          .groupBy(`${alias}.agentId`)
          .orderBy(`COALESCE(SUM(${alias}.totalCost), 0)`, 'DESC')
          .limit(50);
        if (to) qb.andWhere(`${alias}.createdAt < :to`, { to });
        // Team agents outside the viewer's teams, resolved by the caller
        // (BudgetsService.hiddenAgentIds). A null agentId names no agent.
        if (hiddenAgentIds.length > 0) {
          qb.andWhere(`(${alias}."agentId" IS NULL OR ${alias}."agentId" NOT IN (:...hiddenAgentIds))`, { hiddenAgentIds });
        }

        return qb.getRawMany<{ agentId: string; total: string; count: string }>();
      }),
    );

    // An agent can be run in both modes over its life, so the two halves
    // are summed per agent before the top-50 cut is applied.
    const merged = new Map<string, { spentCents: number; runCount: number }>();
    for (const rows of perSource) {
      for (const r of rows) {
        const acc = merged.get(r.agentId) ?? { spentCents: 0, runCount: 0 };
        acc.spentCents += this.toCents(r.total);
        acc.runCount += parseInt(r.count, 10);
        merged.set(r.agentId, acc);
      }
    }

    return [...merged.entries()]
      .map(([agentId, v]) => ({ agentId, ...v }))
      .sort((a, b) => b.spentCents - a.spentCents)
      .slice(0, 50);
  }

  /**
   * Cost attributed per team (T5.4 chargeback). Runs carry no team of
   * their own, so we join through the owning agent's `teamId`. Org-scoped
   * agents (no team) roll up under a `null` bucket.
   */
  async byTeam(
    organizationId: string,
    from: Date,
    to?: Date,
  ): Promise<SpendByTeam[]> {
    const perSource = await Promise.all(
      this.spendSources().map(async ({ repo, alias }) => {
        const qb = repo
          .createQueryBuilder(alias)
          .leftJoin('agents', 'agent', `agent.id = ${alias}.agentId`)
          .select('agent.teamId', 'teamId')
          .addSelect(`COALESCE(SUM(${alias}.totalCost), 0)`, 'total')
          .addSelect('COUNT(*)', 'count')
          .where(`${alias}.organizationId = :orgId`, { orgId: organizationId })
          .andWhere(`${alias}.createdAt >= :from`, { from })
          .groupBy('agent.teamId')
          .orderBy(`COALESCE(SUM(${alias}.totalCost), 0)`, 'DESC');
        if (to) qb.andWhere(`${alias}.createdAt < :to`, { to });

        return qb.getRawMany<{ teamId: string | null; total: string; count: string }>();
      }),
    );

    const merged = new Map<string | null, { spentCents: number; runCount: number }>();
    for (const rows of perSource) {
      for (const r of rows) {
        const key = r.teamId ?? null;
        const acc = merged.get(key) ?? { spentCents: 0, runCount: 0 };
        acc.spentCents += this.toCents(r.total);
        acc.runCount += parseInt(r.count, 10);
        merged.set(key, acc);
      }
    }

    return [...merged.entries()]
      .map(([teamId, v]) => ({ teamId, ...v }))
      .sort((a, b) => b.spentCents - a.spentCents);
  }

  /**
   * Simple least-squares linear forecast (T5.4). Fits a line to the spend
   * timeseries and projects the total spend over the next `periodsAhead`
   * buckets, clamping any negative projection to zero. With fewer than two
   * points there is nothing to fit — we carry the last observed value.
   */
  forecast(timeseries: SpendBucket[], periodsAhead = 1): SpendForecast {
    const ys = timeseries.map((b) => b.spentCents);
    const n = ys.length;
    const ahead = Math.max(1, periodsAhead);

    if (n < 2) {
      const last = n === 1 ? Math.max(0, ys[0]) : 0;
      return {
        projectedCents: last * ahead,
        perPeriodCents: 0,
        periodsAhead: ahead,
        basis: 'insufficient-data',
      };
    }

    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < n; i++) {
      sx += i;
      sy += ys[i];
      sxx += i * i;
      sxy += i * ys[i];
    }
    const denom = n * sxx - sx * sx;
    const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
    const intercept = (sy - slope * sx) / n;

    let projected = 0;
    for (let k = 0; k < ahead; k++) {
      const x = n + k;
      projected += Math.max(0, slope * x + intercept);
    }

    return {
      projectedCents: Math.round(projected),
      perPeriodCents: Math.round(slope),
      periodsAhead: ahead,
      basis: 'linear',
    };
  }
}