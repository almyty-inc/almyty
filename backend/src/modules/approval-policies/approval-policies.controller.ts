import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { EntitlementGuard } from '../licensing/guards/entitlement.guard';
import { RequiresEntitlement } from '../licensing/decorators/requires-entitlement.decorator';
import { EE_ENTITLEMENTS } from '../licensing/license.constants';

import { ApprovalPolicyService } from './approval-policy.service';
import {
  ApprovalMatchCondition,
  ApprovalStep,
} from '../../entities/approval-policy.entity';

class UpsertPolicyDto {
  @IsString()
  @MaxLength(128)
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  teamId?: string | null;

  @IsOptional()
  @IsArray()
  match?: ApprovalMatchCondition[];

  @IsOptional()
  @IsArray()
  steps?: ApprovalStep[];

  @IsOptional()
  @IsInt()
  priority?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/**
 * EE (approval_policy): multi-step / conditional / quorum approval
 * policies. Gated behind the `approval_policy` entitlement + org
 * admin/owner. Single-gate approvals remain available OSS via /approvals.
 */
@Controller('approval-policies')
@ApiTags('Approval Policies (EE)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, EntitlementGuard)
@RequiresEntitlement(EE_ENTITLEMENTS.APPROVAL_POLICY)
@Roles('admin', 'owner')
export class ApprovalPoliciesController {
  constructor(private readonly policies: ApprovalPolicyService) {}

  private orgId(req: any): string {
    return req.user.currentOrganizationId;
  }

  @Get()
  async list(@Request() req: any) {
    return { success: true, data: await this.policies.list(this.orgId(req)) };
  }

  @Post()
  @ApiOperation({ summary: 'Create an approval policy' })
  async create(@Request() req: any, @Body() body: UpsertPolicyDto) {
    const data = await this.policies.create({ organizationId: this.orgId(req), ...body });
    return { success: true, data };
  }

  @Get(':id')
  async get(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    return { success: true, data: await this.policies.get(this.orgId(req), id) };
  }

  @Patch(':id')
  async update(
    @Request() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Partial<UpsertPolicyDto>,
  ) {
    return { success: true, data: await this.policies.update(this.orgId(req), id, body) };
  }

  @Delete(':id')
  async remove(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    await this.policies.remove(this.orgId(req), id);
    return { success: true };
  }
}
