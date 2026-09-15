import { Controller, Get, HttpException, HttpStatus, Query, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';

import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { AgentExecution } from '../../../entities/agent-execution.entity';
import { computeCoFailure, isReportable, MIN_COMPARABLE_REQUESTS } from './co-failure';
import { attemptsFrom, failedAttemptsFrom } from './attempt-records';

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

    const rows = await this.executions.find({
      where: { organizationId, createdAt: MoreThan(since) },
      select: { id: true, agentId: true, nodeResults: true as any },
      take: 5000,
    });

    const attempts = [...attemptsFrom(rows as any), ...failedAttemptsFrom(rows as any)];
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
