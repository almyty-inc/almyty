import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Put,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsIn, IsOptional } from 'class-validator';

import { JwtAuthGuard } from '../../../src/modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../src/modules/auth/guards/roles.guard';
import { Roles } from '../../../src/modules/auth/decorators/roles.decorator';
import { EntitlementGuard } from '../../../src/modules/licensing/guards/entitlement.guard';
import { RequiresEntitlement } from '../../../src/modules/licensing/decorators/requires-entitlement.decorator';
import { EE_ENTITLEMENTS } from '../../../src/modules/licensing/license.constants';

import { ComplianceService } from './compliance.service';
import {
  ComplianceSeverity,
  EnforceablePlugin,
} from '../../../src/entities/compliance-policy.entity';

class UpsertCompliancePolicyDto {
  @IsOptional()
  @IsArray()
  @IsIn(['pii-filter', 'security-scanner'], { each: true })
  enforcedPlugins?: EnforceablePlugin[];

  @IsOptional()
  @IsIn(['low', 'medium', 'high', 'critical'])
  securityThreshold?: ComplianceSeverity;

  @IsOptional()
  @IsBoolean()
  blockOnViolation?: boolean;

  @IsOptional()
  @IsArray()
  piiCategories?: string[];
}

/**
 * EE (compliance_pack): read/manage the enforced org compliance policy and
 * pull a compliance report scored from existing audit + plugin data. Gated
 * behind the `compliance_pack` entitlement (402 without a license) + org
 * admin/owner. The underlying pii-filter/security-scanner plugins stay OSS.
 */
@Controller('compliance')
@ApiTags('Compliance Pack (EE)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, EntitlementGuard)
@RequiresEntitlement(EE_ENTITLEMENTS.COMPLIANCE_PACK)
@Roles('admin', 'owner')
export class ComplianceController {
  constructor(private readonly compliance: ComplianceService) {}

  private orgId(req: any): string {
    return req.user.currentOrganizationId;
  }

  @Get('policy')
  @ApiOperation({ summary: 'Get the effective enforced org compliance policy' })
  async getPolicy(@Request() req: any) {
    const data = await this.compliance.getEffectivePolicy(this.orgId(req));
    return { success: true, data };
  }

  @Put('policy')
  @ApiOperation({ summary: 'Create or update the enforced org compliance policy' })
  async upsertPolicy(@Request() req: any, @Body() body: UpsertCompliancePolicyDto) {
    try {
      const data = await this.compliance.upsertPolicy(this.orgId(req), body);
      return { success: true, data };
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }

  @Get('report')
  @ApiOperation({ summary: 'Get a compliance report over a time window' })
  async getReport(
    @Request() req: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const data = await this.compliance.getReport(this.orgId(req), {
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
    return { success: true, data };
  }
}
