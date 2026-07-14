import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Request,
  UseGuards,
  HttpStatus,
  HttpException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { startOfPeriod } from '../budgets/spend-period.util';
import { ProviderUsageService } from './provider-usage.service';
import { listProviderUsageCapabilities } from './provider-usage.capability';

interface SyncBody {
  from?: string;
  to?: string;
  providerId?: string;
}

/**
 * External provider usage/cost ingestion + reconciliation (P7). Reads are
 * member+, the sync (which reaches out to provider admin APIs) is
 * admin/owner — same RBAC shape as the budgets/LLM-providers controllers.
 */
@Controller('provider-usage')
@ApiTags('Cost Governance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
export class ProviderUsageController {
  constructor(private readonly usage: ProviderUsageService) {}

  private orgId(req: any): string {
    const organizationId = req.user?.currentOrganizationId;
    if (!organizationId) {
      throw new HttpException(
        {
          success: false,
          message:
            'Organization context required. Multi-org users must send the X-Organization-Id header.',
          error: 'NO_ORGANIZATION',
        },
        HttpStatus.BAD_REQUEST,
      );
    }
    return organizationId;
  }

  private window(period: string | undefined, from?: string, to?: string) {
    if (from) {
      return { from: new Date(from), to: to ? new Date(to) : new Date() };
    }
    const periodType = period === 'day' ? 'day' : 'month';
    return { from: startOfPeriod(periodType, new Date()), to: new Date() };
  }

  @Get('capabilities')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({
    summary: 'List which provider types expose an ingestible usage/cost API',
  })
  getCapabilities() {
    return { success: true, data: listProviderUsageCapabilities() };
  }

  @Get('reconciliation')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({
    summary: 'Per-provider our-estimate vs provider-actual cost + delta',
  })
  async reconciliation(
    @Query('period') period: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Request() req: any,
  ) {
    const organizationId = this.orgId(req);
    const w = this.window(period, from, to);
    const data = await this.usage.getReconciliation(organizationId, w);
    return {
      success: true,
      data: { from: w.from, to: w.to, providers: data },
    };
  }

  @Post('sync')
  @Roles('admin', 'owner')
  @ApiOperation({
    summary: 'Pull + upsert provider-actual usage snapshots for a window',
  })
  async sync(@Body() body: SyncBody, @Request() req: any) {
    const organizationId = this.orgId(req);
    const w = this.window('month', body.from, body.to);
    const data = await this.usage.syncOrganization(
      organizationId,
      w.from,
      w.to,
      body.providerId,
    );
    return { success: true, data: { from: w.from, to: w.to, results: data } };
  }
}
