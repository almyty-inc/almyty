import {
  Body,
  Controller,
  Delete,
  Get,
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
import { IsArray, IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';
import type { Response } from 'express';

import { JwtAuthGuard } from '../../../src/modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../src/modules/auth/guards/roles.guard';
import { Roles } from '../../../src/modules/auth/decorators/roles.decorator';
import { RbacAction, RBAC_PERMISSIONS } from '../../../src/common/authorization/rbac-actions';
import { EntitlementGuard } from '../../../src/modules/licensing/guards/entitlement.guard';
import { RequiresEntitlement } from '../../../src/modules/licensing/decorators/requires-entitlement.decorator';
import { EE_ENTITLEMENTS } from '../../../src/modules/licensing/license.constants';

import { AuditExportService } from './audit-export.service';
import { AuditStreamService } from './audit-stream.service';
import { AuditAction, AuditResource } from '../../../src/entities/audit-log.entity';
import { AuditStreamTarget } from '../../../src/entities/audit-stream-config.entity';

class CreateStreamDto {
  @IsIn(['webhook', 'splunk_hec', 'datadog'])
  target: AuditStreamTarget;

  @IsString()
  endpoint: string;

  @IsOptional()
  @IsString()
  token?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  actionFilter?: string[];
}

class UpdateStreamDto {
  @IsOptional()
  @IsString()
  endpoint?: string;

  /** Absent keeps the token; empty or null clears it. */
  @IsOptional()
  @IsString()
  token?: string | null;

  /** The actions to stream; empty or null streams every action. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  actionFilter?: string[] | null;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
/**
 * EE (audit_export): audit export (JSON/CSV download) + SIEM stream
 * config. Gated behind the `audit_export` entitlement and org
 * admin/owner. The OSS audit-log query endpoints are unaffected.
 */
@Controller('audit-export')
@ApiTags('Audit Export (EE)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, EntitlementGuard)
@RequiresEntitlement(EE_ENTITLEMENTS.AUDIT_EXPORT)
@Roles('admin', 'owner')
@RbacAction(RBAC_PERMISSIONS.AUDIT_EXPORT)
export class AuditExportController {
  constructor(
    private readonly exportService: AuditExportService,
    private readonly streamService: AuditStreamService,
  ) {}

  private orgId(req: any): string {
    return req.user.currentOrganizationId;
  }

  @Get()
  @ApiOperation({ summary: 'Download the audit trail as JSON or CSV' })
  async download(
    @Request() req: any,
    @Res() res: Response,
    @Query('format') format?: string,
    @Query('resourceType') resourceType?: AuditResource,
    @Query('action') action?: AuditAction,
    @Query('userId') userId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    const fmt = format === 'csv' ? 'csv' : 'json';
    const result = await this.exportService.export(fmt, {
      organizationId: this.orgId(req),
      resourceType,
      action,
      userId,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('X-Audit-Export-Count', String(result.count));
    res.send(result.body);
  }

  // ── SIEM stream targets ──

  @Get('streams')
  async listStreams(@Request() req: any) {
    const rows = await this.streamService.list(this.orgId(req));
    // The token is the target's shared secret -- a Splunk HEC token, a
    // Datadog API key, a webhook bearer. Returning the rows as stored put
    // it in every admin's browser, in their network log, and within reach
    // of any XSS, for a field the UI never even displays. The write path
    // already treats it as write-only; this one did not.
    return { success: true, data: rows.map(withoutToken) };
  }

  @Post('streams')
  @ApiOperation({ summary: 'Configure a SIEM streaming target' })
  async createStream(@Request() req: any, @Body() body: CreateStreamDto) {
    const data = await this.streamService.create({
      organizationId: this.orgId(req),
      ...body,
    });
    return { success: true, data: withoutToken(data) };
  }

  @Patch('streams/:id')
  @ApiOperation({ summary: 'Change a SIEM streaming target: endpoint, token, which actions it streams, on or off' })
  async updateStream(
    @Request() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateStreamDto,
  ) {
    const data = await this.streamService.update(this.orgId(req), id, body);
    return { success: true, data: withoutToken(data) };
  }

  @Delete('streams/:id')
  async deleteStream(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    await this.streamService.remove(this.orgId(req), id);
    return { success: true };
  }
}

/** A target as the page sees it: whether it has a token, never the token. */
function withoutToken<T extends { token?: string | null }>(row: T): Omit<T, 'token'> & { hasToken: boolean } {
  const { token, ...rest } = row;
  return { ...rest, hasToken: Boolean(token) };
}