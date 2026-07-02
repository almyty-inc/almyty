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
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

import { JwtAuthGuard } from '../../../src/modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../src/modules/auth/guards/roles.guard';
import { Roles } from '../../../src/modules/auth/decorators/roles.decorator';
import { EntitlementGuard } from '../../../src/modules/licensing/guards/entitlement.guard';
import { RequiresEntitlement } from '../../../src/modules/licensing/decorators/requires-entitlement.decorator';
import { EE_ENTITLEMENTS } from '../../../src/modules/licensing/license.constants';

import { CustomRoleService } from './custom-role.service';
import { AbacCondition, AbacEffect } from '../../../src/entities/abac-policy.entity';

class CreateRoleDto {
  @IsString()
  @MaxLength(64)
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permissions?: string[];
}

class UpdateRoleDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permissions?: string[];

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

class AssignDto {
  @IsString()
  userId: string;
}

class CreatePolicyDto {
  @IsString()
  @MaxLength(128)
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsIn(['allow', 'deny'])
  effect?: AbacEffect;

  @IsOptional()
  @IsString()
  action?: string;

  @IsOptional()
  @IsArray()
  conditions?: AbacCondition[];

  @IsOptional()
  @IsInt()
  priority?: number;
}

/**
 * EE (advanced_rbac): custom roles + ABAC policies. Every route is gated
 * behind the `advanced_rbac` entitlement (402 without a license) AND
 * requires org admin/owner. The community build keeps the fixed
 * owner/admin/member/viewer roles and never exposes these endpoints.
 */
@Controller('rbac')
@ApiTags('RBAC (EE)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, EntitlementGuard)
@RequiresEntitlement(EE_ENTITLEMENTS.ADVANCED_RBAC)
@Roles('admin', 'owner')
export class RbacController {
  constructor(private readonly rbac: CustomRoleService) {}

  private orgId(req: any): string {
    return req.user.currentOrganizationId;
  }

  // ── Custom roles ──

  @Get('roles')
  @ApiOperation({ summary: 'List custom roles' })
  async listRoles(@Request() req: any) {
    return { success: true, data: await this.rbac.listRoles(this.orgId(req)) };
  }

  @Post('roles')
  @ApiOperation({ summary: 'Create a custom role' })
  async createRole(@Request() req: any, @Body() body: CreateRoleDto) {
    const data = await this.rbac.createRole({ organizationId: this.orgId(req), ...body });
    return { success: true, data };
  }

  @Get('roles/:id')
  async getRole(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    return { success: true, data: await this.rbac.getRole(this.orgId(req), id) };
  }

  @Patch('roles/:id')
  async updateRole(
    @Request() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateRoleDto,
  ) {
    return { success: true, data: await this.rbac.updateRole(this.orgId(req), id, body) };
  }

  @Delete('roles/:id')
  async deleteRole(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    await this.rbac.deleteRole(this.orgId(req), id);
    return { success: true };
  }

  // ── Assignments ──

  @Post('roles/:id/assignments')
  @ApiOperation({ summary: 'Assign a custom role to a user' })
  async assign(
    @Request() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AssignDto,
  ) {
    const data = await this.rbac.assign(this.orgId(req), id, body.userId, req.user.id);
    return { success: true, data };
  }

  @Delete('roles/:id/assignments/:userId')
  async unassign(
    @Request() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    await this.rbac.unassign(this.orgId(req), id, userId);
    return { success: true };
  }

  @Get('users/:userId/permissions')
  @ApiOperation({ summary: "Resolve a user's effective custom-role permissions" })
  async effective(@Request() req: any, @Param('userId', ParseUUIDPipe) userId: string) {
    const data = await this.rbac.getEffectivePermissions(this.orgId(req), userId);
    return { success: true, data };
  }

  // ── ABAC policies ──

  @Get('policies')
  async listPolicies(@Request() req: any) {
    return { success: true, data: await this.rbac.listPolicies(this.orgId(req)) };
  }

  @Post('policies')
  @ApiOperation({ summary: 'Create an ABAC policy' })
  async createPolicy(@Request() req: any, @Body() body: CreatePolicyDto) {
    const data = await this.rbac.createPolicy({ organizationId: this.orgId(req), ...body });
    return { success: true, data };
  }

  @Delete('policies/:id')
  async deletePolicy(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    await this.rbac.deletePolicy(this.orgId(req), id);
    return { success: true };
  }
}
