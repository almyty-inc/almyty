import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import { EnvironmentsService } from './environments.service';
import { HostedRunnerSettingsService } from './hosted-runner-settings';
import { HostedRunnersService } from './hosted-runners.service';
import { overageUsd } from './hosted-capacity.provider';
import { alwaysOnCapacity } from '../agents/always-on/always-on-capacity';

/** Minutes per resource class, and their sum. */
export interface UsageMinutes {
  minutes: number;
  byClass: Record<string, number>;
}

/**
 * What the Hosted tab reads besides the environments themselves: the
 * choices an environment form offers (from the install's settings and the
 * organization's capacity, never from constants in the page), runner
 * minutes over a period, and the runs an environment served.
 */
@Injectable()
export class EnvironmentInsightsService {
  constructor(
    private readonly settings: HostedRunnerSettingsService,
    private readonly hosted: HostedRunnersService,
    private readonly environments: EnvironmentsService,
    private readonly accessPolicy: AccessPolicyService,
    private readonly dataSource: DataSource,
  ) {}

  /** The form's choices: curated images, sizes this organization may use, the idle-timeout bounds and how long files are kept. */
  async options(organizationId: string) {
    const s = this.settings.current;
    const capacity = await this.hosted.capacityFor(organizationId);
    const allowed = capacity.resourceClasses ?? Object.keys(s.resourceClasses);
    return {
      enabled: this.settings.enabled(),
      images: Object.keys(s.images),
      resourceClasses: Object.entries(s.resourceClasses)
        .filter(([name]) => allowed.includes(name))
        .map(([name, size]) => ({ name, ...size })),
      defaultResourceClass: s.defaultResourceClass,
      idleTimeoutMinutes: { ...s.idleTimeoutMinutes },
      suspendedRetention: { ...s.suspendedRetention },
      usageRetentionMonths: s.usageRetention.months,
      capacity: { maxConcurrentRunners: capacity.maxConcurrentRunners, maxWorkspaces: capacity.maxWorkspaces },
    };
  }

  /**
   * The plan's hosted capacity as the Hosted tab shows it: for each limit,
   * what is used now and what the limit is. A null limit is no limit.
   * `plan` is null where no plan applies (an install that sells none).
   */
  async capacity(organizationId: string, now = new Date()) {
    const capacity = await this.hosted.capacityFor(organizationId);
    const [running, workspaces, minutes, orgRows, homeRows] = await Promise.all([
      this.hosted.runningCount(organizationId),
      this.hosted.workspaceCount(organizationId),
      this.hosted.minutesThisMonth(organizationId, now),
      this.dataSource.query(`SELECT plan, settings FROM organizations WHERE id = $1`, [organizationId]),
      this.dataSource.query(
        `SELECT COUNT(*)::int AS n FROM agents
          WHERE "organizationId" = $1 AND status = 'active' AND mode = 'autonomous'
            AND ("alwaysOn"::jsonb ->> 'enabled') = 'true'
            AND COALESCE("alwaysOn"::jsonb -> 'home' ->> 'environmentId', '') <> ''`,
        [organizationId],
      ),
    ]);
    const included = capacity.includedMinutes ?? null;
    const prices = capacity.usdPerMinute ?? null;
    const classes = Array.from(new Set([...Object.keys(included ?? {}), ...Object.keys(minutes)])).sort();
    const usedMinutes = Object.values(minutes).reduce((a, b) => a + b, 0);
    const ceiling = capacity.monthlyCeilingMinutes ?? null;
    const plan = capacity.plan ?? null;
    return {
      plan,
      hostedEnvironments: capacity.hostedEnvironments !== false,
      billed: capacity.billed === true,
      machinesRunning: { used: running, limit: capacity.maxConcurrentRunners },
      workspacesKept: { used: workspaces, limit: capacity.maxWorkspaces },
      // The sizes the plan allows; null: every size the install offers.
      resourceClasses: capacity.resourceClasses ?? null,
      minutesThisMonth: {
        used: usedMinutes,
        ceiling,
        byClass: classes.map((resourceClass) => ({
          resourceClass,
          used: minutes[resourceClass] ?? 0,
          included: included ? (included[resourceClass] ?? 0) : null,
          usdPerMinute: prices?.[resourceClass] ?? null,
        })),
      },
      // Overage this month in dollars, against the plan's dollar ceiling.
      spendThisMonth: {
        usd: overageUsd(minutes, included, prices),
        ceilingUsd: capacity.monthlyCeilingUsd ?? null,
      },
      // Always-on agents whose home is a hosted machine: the only ones a plan limits.
      alwaysOnHosted: {
        used: Number(homeRows?.[0]?.n ?? 0),
        // The same numbers Always on enforces (always-on-capacity.ts).
        limit: alwaysOnCapacity(orgRows?.[0] ?? null).includedAgents,
      },
    };
  }

  /** The current calendar month (UTC) up to now, unless the caller names a period. */
  period(from?: string, to?: string, now = new Date()): { from: Date; to: Date } {
    const start = from ? new Date(from) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = to ? new Date(to) : now;
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start.getTime() >= end.getTime()) {
      throw new BadRequestException('from and to must be ISO dates with from before to');
    }
    return { from: start, to: end };
  }

  /**
   * The caller's own machine on each of these environments, for the list:
   * their live persistent workspace there (not an agent's own, and not a
   * read-only one inherited from a member who left) and its hosted
   * runner's state, or null when they have none yet.
   */
  async machines(userId: string, organizationId: string, environmentIds: string[]) {
    const out: Record<string, { workspaceId: string; status: string; lastActiveAt: Date | null; machine: ReturnType<HostedRunnersService['machineView']> | null } | null> = {};
    for (const id of environmentIds) out[id] = null;
    if (environmentIds.length === 0) return out;
    const rows: Array<Record<string, any>> = await this.dataSource.query(
      `SELECT w.id AS "workspaceId", w."environmentId", w.status, w."lastActiveAt",
              h.id AS "machineId", h.state, h.desired, h."lastError"
         FROM workspaces w
         LEFT JOIN hosted_runners h ON h."workspaceId" = w.id AND h.state NOT IN ('torn_down', 'orphaned')
        WHERE w."organizationId" = $1 AND w."ownerUserId" = $2 AND w."agentId" IS NULL AND w."readOnly" = false
          AND w.kind = 'persistent' AND w.status IN ('active', 'suspended') AND w."environmentId" = ANY($3::uuid[])`,
      [organizationId, userId, environmentIds],
    );
    for (const r of rows) {
      out[r.environmentId] = {
        workspaceId: r.workspaceId,
        status: r.status,
        lastActiveAt: r.lastActiveAt,
        machine: r.machineId ? this.hosted.machineView({ id: r.machineId, state: r.state, desired: r.desired, lastActiveAt: null, lastError: r.lastError }) : null,
      };
    }
    return out;
  }

  /**
   * Runner minutes in [from, to), open intervals counted up to `to`: per
   * environment the caller may see, and for the whole organization when
   * the caller is an owner or admin (null otherwise).
   */
  async usage(userId: string, organizationId: string, from: Date, to: Date) {
    const rows: Array<{ environmentId: string; resourceClass: string; seconds: string }> = await this.dataSource.query(
      `SELECT "environmentId", "resourceClass",
              SUM(EXTRACT(EPOCH FROM (LEAST(COALESCE("endedAt", $3), $3) - GREATEST("startedAt", $2)))) AS seconds
         FROM runner_usage_intervals
        WHERE "organizationId" = $1 AND "startedAt" < $3 AND ("endedAt" IS NULL OR "endedAt" > $2)
        GROUP BY "environmentId", "resourceClass"`,
      [organizationId, from, to],
    );
    const byEnvironment = new Map<string, UsageMinutes>();
    const organization: UsageMinutes = { minutes: 0, byClass: {} };
    for (const row of rows) {
      const minutes = Math.max(0, Number(row.seconds)) / 60;
      const env = byEnvironment.get(row.environmentId) ?? { minutes: 0, byClass: {} };
      env.minutes += minutes;
      env.byClass[row.resourceClass] = (env.byClass[row.resourceClass] ?? 0) + minutes;
      byEnvironment.set(row.environmentId, env);
      organization.minutes += minutes;
      organization.byClass[row.resourceClass] = (organization.byClass[row.resourceClass] ?? 0) + minutes;
    }
    const visible = await this.environments.list(userId, organizationId);
    const role = await this.accessPolicy.getOrgRole(userId, organizationId);
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      environments: visible.map((env) => ({ environmentId: env.id, name: env.name, ...(byEnvironment.get(env.id) ?? { minutes: 0, byClass: {} }) })),
      organization: role === 'owner' || role === 'admin' ? organization : null,
    };
  }

  /**
   * The runs of agents whose machine is this environment
   * (`agentConfig.environmentId`), newest first: autonomous runs (top-level
   * only) and workflow executions. The caller's own; every one for an
   * owner or admin.
   */
  async runs(environmentId: string, userId: string, organizationId: string, limit?: number) {
    await this.hosted.assertReadableEnvironment(environmentId, userId, organizationId);
    const { defaultLimit, maxLimit } = this.settings.current.runsList;
    const take = Math.min(maxLimit, Math.max(1, Math.floor(Number(limit) || defaultLimit)));
    const role = await this.accessPolicy.getOrgRole(userId, organizationId);
    const all = role === 'owner' || role === 'admin';
    return this.dataSource.query(
      `SELECT * FROM (
         SELECT r.id, 'run' AS kind, r."agentId", a.name AS "agentName", r.status, r."userId", r."createdAt", r."updatedAt"
           FROM agent_runs r JOIN agents a ON a.id = r."agentId"
          WHERE r."organizationId" = $1 AND a."agentConfig"::jsonb ->> 'environmentId' = $2 AND r."parentRunId" IS NULL
            AND ($3::boolean OR r."userId" = $4)
         UNION ALL
         SELECT e.id, 'execution' AS kind, e."agentId", a.name AS "agentName", e.status::text, e."userId", e."createdAt", e."updatedAt"
           FROM agent_executions e JOIN agents a ON a.id = e."agentId"
          WHERE e."organizationId" = $1 AND a."agentConfig"::jsonb ->> 'environmentId' = $2
            AND ($3::boolean OR e."userId" = $4)
       ) runs
       ORDER BY "createdAt" DESC
       LIMIT $5`,
      [organizationId, environmentId, all, userId, take],
    );
  }
}
