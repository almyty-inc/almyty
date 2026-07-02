import { Controller, Get, Query, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../../src/modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../src/modules/auth/guards/roles.guard';
import { Roles } from '../../../src/modules/auth/decorators/roles.decorator';
import { EntitlementGuard } from '../../../src/modules/licensing/guards/entitlement.guard';
import { RequiresEntitlement } from '../../../src/modules/licensing/decorators/requires-entitlement.decorator';
import { EE_ENTITLEMENTS } from '../../../src/modules/licensing/license.constants';

import { ChargebackService } from './chargeback.service';

/**
 * EE (chargeback): per-team + per-agent cost attribution and a linear
 * spend forecast. Gated behind the `chargeback` entitlement (402 without a
 * license) + org admin/owner. Reuses the OSS spend aggregation.
 */
@Controller('chargeback')
@ApiTags('Chargeback (EE)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, EntitlementGuard)
@RequiresEntitlement(EE_ENTITLEMENTS.CHARGEBACK)
@Roles('admin', 'owner')
export class ChargebackController {
  constructor(private readonly chargeback: ChargebackService) {}

  private orgId(req: any): string {
    return req.user.currentOrganizationId;
  }

  @Get('report')
  @ApiOperation({ summary: 'Chargeback report: cost per team + agent + forecast' })
  async getReport(
    @Request() req: any,
    @Query('period') period?: string,
    @Query('granularity') granularity?: string,
    @Query('forecastPeriods') forecastPeriods?: string,
  ) {
    const data = await this.chargeback.getReport(this.orgId(req), {
      period: period === 'day' ? 'day' : 'month',
      granularity: granularity as any,
      forecastPeriods: forecastPeriods ? parseInt(forecastPeriods, 10) : undefined,
    });
    return { success: true, data };
  }
}
