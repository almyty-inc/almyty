import { Controller, Get, HttpException, HttpStatus, Query, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { AgentExecution } from '../../../entities/agent-execution.entity';
import { computeCoFailure, isReportable, MIN_COMPARABLE_REQUESTS } from './co-failure';
import {
  attemptsFrom,
  executionsFromRoutingRows,
  failedAttemptsFrom,
  RoutingAttemptRow,
} from './attempt-records';

/**
 * How many runs one answer is allowed to look at.
 *
 * A cap rather than the whole window, because the window is
 * caller-supplied up to 90 days. Paired with the `ORDER BY` in the query
 * so the sample is the most recent runs and the same call twice gives the
 * same answer.
 */
const EXECUTION_SAMPLE = 5000;

/**
 * How often every model failed the same request.
 *
 * On screen this is the All-model failure rate, and it binds to
 * `coFailureRate`. The neighbouring `routingHeadroomRate` is a DIFFERENT
 * number -- the share a better policy could have won -- and the two must
 * never be shown under one label: a chart bound to the wrong field reads
 * perfectly plausibly and nobody catches it by looking.
 *
 * Reported only once there is enough history to mean anything. A rate
 * computed from four requests is noise wearing a percentage sign, and
 * publishing it invites decisions nobody should make.
 */
@ApiTags('Analytics')
@ApiBearerAuth()
@Controller('analytics/routing')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RoutingAnalyticsController {
  constructor(@InjectRepository(AgentExecution) private readonly executions: Repository<AgentExecution>) {}

  private orgId(req: any): string {
    const organizationId = req.user?.currentOrganizationId;
    if (!organizationId) {
      throw new HttpException({ success: false, message: 'No organization found for user', error: 'NO_ORGANIZATION' }, HttpStatus.BAD_REQUEST);
    }
    return organizationId;
  }

  @Get('failure-rate')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'All-model failure rate per agent, from the runs already recorded' })
  async failureRate(@Request() req: any, @Query('days') days?: string) {
    const organizationId = this.orgId(req);
    // Nonsense in means the default, not one day's worth: clamping a
    // negative to 1 would answer with almost no history and look like a
    // real answer.
    const asked = Number(days);
    const window = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 90) : 30;
    const since = new Date(Date.now() - window * 24 * 60 * 60 * 1000);

    // Extract the routing stamp in SQL; leave the node outputs in the
    // database.
    //
    // This used to select `nodeResults` whole with `take: 5000`. Node
    // payloads are capped at 32KB each, so a ten-node run is ~320KB and
    // the window materialises up to 1.6GB in one request -- ~100MB even
    // at a realistic 20KB average -- to read `routing.modelId`,
    // `routing.tried[].modelId` and `triedModels[]`, a few dozen bytes
    // per node.
    //
    // The sample is also ordered now. Without an `order` the 5,000 were
    // whatever the planner returned, so the same window answered
    // differently on consecutive calls and nobody could tell a real
    // movement from a reshuffled sample.
    const rows: RoutingAttemptRow[] = await this.executions.query(
      `
      WITH recent AS (
        SELECT e."id", e."agentId", e."nodeResults"
        FROM "agent_executions" e
        WHERE e."organizationId" = $1
          AND e."createdAt" > $2
          AND e."nodeResults" IS NOT NULL
          AND json_typeof(e."nodeResults") = 'object'
        ORDER BY e."createdAt" DESC, e."id" DESC
        LIMIT $3
      )
      SELECT
        r."id"::text      AS "executionId",
        r."agentId"::text AS "agentId",
        n.key             AS "nodeId",
        CASE WHEN json_typeof(n.value -> 'routing') = 'object'
             THEN n.value -> 'routing' ->> 'modelId' END AS "modelId",
        CASE WHEN json_typeof(n.value -> 'routing' -> 'tried') = 'array'
             THEN n.value -> 'routing' -> 'tried' END    AS "tried",
        CASE WHEN json_typeof(n.value -> 'triedModels') = 'array'
             THEN n.value -> 'triedModels' END           AS "triedModels",
        (
          (n.value -> 'error') IS NOT NULL
          AND json_typeof(n.value -> 'error') <> 'null'
          AND COALESCE(n.value ->> 'error', '') NOT IN ('', 'false')
        ) AS "hasError"
      FROM recent r
      CROSS JOIN LATERAL json_each(r."nodeResults") AS n
      WHERE json_typeof(n.value) = 'object'
        AND (
          json_typeof(n.value -> 'routing') = 'object'
          OR json_typeof(n.value -> 'triedModels') = 'array'
        )
      ORDER BY r."id", n.key
      `,
      [organizationId, since, EXECUTION_SAMPLE],
    );

    const executions = executionsFromRoutingRows(rows ?? []);
    const attempts = [...attemptsFrom(executions), ...failedAttemptsFrom(executions)];
    const stats = computeCoFailure(attempts);

    return {
      success: true,
      data: {
        windowDays: window,
        minimumRequests: MIN_COMPARABLE_REQUESTS,
        // Everything, with a flag, rather than only what is reportable:
        // a surface that silently drops the thin classes cannot tell a
        // person why their agent is missing from the chart.
        perAgent: stats.map((s) => ({
          agentId: s.taskClass,
          comparableRequests: s.comparableRequests,
          allModelFailureRate: s.coFailureRate,
          recoverableRate: s.routingHeadroomRate,
          reportable: isReportable(s),
        })),
      },
    };
  }
}
