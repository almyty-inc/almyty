import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Request,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsArray, IsIn, IsOptional, IsString } from 'class-validator';
import type { Response } from 'express';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { EntitlementGuard } from '../licensing/guards/entitlement.guard';
import { RequiresEntitlement } from '../licensing/decorators/requires-entitlement.decorator';
import { EE_ENTITLEMENTS } from '../licensing/license.constants';

import { AuditExportService } from './audit-export.service';
import { AuditStreamService } from './audit-stream.service';
import { AuditAction, AuditResource } from '../../entities/audit-log.entity';
import { AuditStreamTarget } from '../../entities/audit-stream-config.entity';

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
    return { success: true, data: await this.streamService.list(this.orgId(req)) };
  }

  @Post('streams')
  @ApiOperation({ summary: 'Configure a SIEM streaming target' })
  async createStream(@Request() req: any, @Body() body: CreateStreamDto) {
    const data = await this.streamService.create({
      organizationId: this.orgId(req),
      ...body,
    });
    return { success: true, data };
  }

  @Delete('streams/:id')
  async deleteStream(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    await this.streamService.remove(this.orgId(req), id);
    return { success: true };
  }
}
