import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Request,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Response } from 'express';

import { CONNECTION_POLICY_KINDS, ConnectionPolicyKind } from '../../../src/entities/connection-policy.entity';
import { GRANT_PRINCIPAL_TYPES, GrantPrincipalType } from '../../../src/entities/connection-grant.entity';
import { JwtAuthGuard } from '../../../src/modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../src/modules/auth/guards/roles.guard';
import { Roles } from '../../../src/modules/auth/decorators/roles.decorator';
import { EntitlementGuard } from '../../../src/modules/licensing/guards/entitlement.guard';
import { RequiresEntitlement } from '../../../src/modules/licensing/decorators/requires-entitlement.decorator';
import { EE_ENTITLEMENTS } from '../../../src/modules/licensing/license.constants';
import { ConnectionsGovernanceService } from './connections-governance.service';
import { GroupPrincipalSyncService } from './group-principal-sync.service';

export class CreatePolicyDto {
  @IsIn(CONNECTION_POLICY_KINDS as readonly string[])
  kind: ConnectionPolicyKind;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  name?: string | null;

  /** Validated per kind by the service. */
  rule: unknown;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdatePolicyDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  name?: string | null;

  @IsOptional()
  rule?: unknown;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class RevokeGrantsDto {
  @IsOptional()
  @IsArray()
  @IsIn(GRANT_PRINCIPAL_TYPES as readonly string[], { each: true })
  principalTypes?: GrantPrincipalType[];
}

/**
 * EE (connections_governance): policy rules, the user-scoped
 * connections review, expiry and rotation triggers, and the audit
 * export of the connections event stream. Every route is gated by the
 * entitlement (402 in the community build) and restricted to org
 * owner/admin. Mounted at `/ee/connections`, apart from the core
 * `/connections` and `/connectors` routes.
 */
@ApiTags('Connections Governance (EE)')
@ApiBearerAuth()
@Controller('ee/connections')
@UseGuards(JwtAuthGuard, RolesGuard, EntitlementGuard)
@RequiresEntitlement(EE_ENTITLEMENTS.CONNECTIONS_GOVERNANCE)
@Roles('owner', 'admin')
export class ConnectionsGovernanceController {
  constructor(
    private readonly governance: ConnectionsGovernanceService,
    private readonly principals: GroupPrincipalSyncService,
  ) {}

  private orgId(req: any): string {
    const organizationId = req?.user?.currentOrganizationId;
    if (!organizationId) {
      throw new HttpException(
        { success: false, message: 'Organization context required. Multi-org users must send the X-Organization-Id header.', error: 'NO_ORGANIZATION' },
        HttpStatus.BAD_REQUEST,
      );
    }
    return organizationId;
  }

  // ── Policies ──

  @Get('policies')
  @ApiOperation({ summary: 'List the organization connection policies' })
  async listPolicies(@Request() req: any) {
    return { success: true, data: await this.governance.list(this.orgId(req)) };
  }

  @Post('policies')
  @ApiOperation({ summary: 'Create a connection policy' })
  async createPolicy(@Request() req: any, @Body() body: CreatePolicyDto) {
    const data = await this.governance.create(this.orgId(req), req.user?.id ?? null, body);
    return { success: true, data };
  }

  @Get('policies/:id')
  async getPolicy(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    return { success: true, data: await this.governance.get(this.orgId(req), id) };
  }

  @Patch('policies/:id')
  @ApiOperation({ summary: 'Update a connection policy (rule, name, enabled)' })
  async updatePolicy(@Request() req: any, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdatePolicyDto) {
    const data = await this.governance.update(this.orgId(req), id, req.user?.id ?? null, body);
    return { success: true, data };
  }

  @Delete('policies/:id')
  async removePolicy(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    await this.governance.remove(this.orgId(req), id, req.user?.id ?? null);
    return { success: true };
  }

  // ── Review ──

  @Get('review')
  @ApiOperation({ summary: 'User-scoped connections granted to agents and workspaces' })
  async review(@Request() req: any, @Query('environment') environment?: string) {
    const data = await this.governance.review(this.orgId(req), environment ?? 'any');
    return { success: true, data, count: data.length };
  }

  @Post('review/:connectionId/revoke-grants')
  @ApiOperation({ summary: 'Revoke the agent and workspace grants on a user-scoped connection' })
  async revokeGrants(@Request() req: any, @Param('connectionId', ParseUUIDPipe) connectionId: string, @Body() body: RevokeGrantsDto) {
    const data = await this.governance.revokeGrants(this.orgId(req), connectionId, { id: req.user.id }, body?.principalTypes?.length ? body.principalTypes : undefined);
    return { success: true, data };
  }

  // ── Expiry + rotation ──

  @Get('expiring')
  @ApiOperation({ summary: 'Connections inside the expiry warning window and past the maximum age' })
  async expiring(@Request() req: any) {
    return { success: true, data: await this.governance.expiring(this.orgId(req)) };
  }

  @Post('expiring/enforce')
  @ApiOperation({ summary: 'Run the expiry enforcement now for this organization' })
  async enforceExpiry(@Request() req: any) {
    return { success: true, data: await this.governance.enforceExpiry(this.orgId(req)) };
  }

  @Get('rotate-due')
  @ApiOperation({ summary: 'Connections due for rotation, split by provider API vs manual' })
  async rotationCandidates(@Request() req: any) {
    return { success: true, data: await this.governance.rotationCandidates(this.orgId(req)) };
  }

  @Post('rotate-due')
  @ApiOperation({ summary: 'Run the scheduled rotation now for this organization' })
  async rotateDue(@Request() req: any) {
    return { success: true, data: await this.governance.rotateDue(this.orgId(req)) };
  }

  // ── Principals ──

  @Post('principals/sync')
  @ApiOperation({ summary: 'Align team membership with the identity provider groups' })
  async syncPrincipals(@Request() req: any) {
    return { success: true, data: await this.principals.syncGroups(this.orgId(req)) };
  }

  // ── Audit export ──

  @Get('audit-export')
  @ApiOperation({ summary: 'Download the connections event stream as JSON or CSV' })
  async auditExport(
    @Request() req: any,
    @Res() res: Response,
    @Query('format') format?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    const fmt = format === 'csv' ? 'csv' : 'json';
    const result = await this.governance.export(this.orgId(req), fmt, {
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('X-Audit-Export-Count', String(result.count));
    res.setHeader('X-Audit-Retention-Days', result.retentionDays === null ? 'unlimited' : String(result.retentionDays));
    res.send(result.body);
  }
}
