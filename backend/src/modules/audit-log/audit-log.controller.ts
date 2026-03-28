import {
  Controller, Get, Query, UseGuards, Request,
  HttpStatus, HttpException, Logger,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { AuditLogService } from './audit-log.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuditResource, AuditAction } from '../../entities/audit-log.entity';

@Controller('audit-logs')
@ApiTags('Audit Logs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
export class AuditLogController {
  private readonly logger = new Logger(AuditLogController.name);

  constructor(private readonly auditLogService: AuditLogService) {}

  private getOrgId(req: any): string {
    const organizationId = req.user.currentOrganizationId || req.user.organizations?.[0]?.id;
    if (!organizationId) {
      throw new HttpException(
        { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
        HttpStatus.BAD_REQUEST,
      );
    }
    return organizationId;
  }

  @Get()
  @Roles('admin', 'owner')
  async findAll(
    @Query() query: {
      resourceType?: AuditResource;
      resourceId?: string;
      action?: AuditAction;
      userId?: string;
      from?: string;
      to?: string;
      page?: string;
      limit?: string;
    },
    @Request() req: any,
  ) {
    try {
      const organizationId = this.getOrgId(req);
      const result = await this.auditLogService.findAll({
        organizationId,
        resourceType: query.resourceType,
        resourceId: query.resourceId,
        action: query.action,
        userId: query.userId,
        from: query.from ? new Date(query.from) : undefined,
        to: query.to ? new Date(query.to) : undefined,
        page: query.page ? parseInt(query.page) : 1,
        limit: query.limit ? parseInt(query.limit) : 50,
      });
      return {
        success: true,
        data: result.data,
        pagination: {
          total: result.total,
          page: result.page,
          limit: result.limit,
          totalPages: result.totalPages,
        },
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: error.message, error: 'AUDIT_LOG_FETCH_FAILED' },
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('resource')
  @Roles('member', 'admin', 'owner')
  async getResourceHistory(
    @Query('resourceType') resourceType: AuditResource,
    @Query('resourceId') resourceId: string,
    @Query('limit') limit: string,
    @Request() req: any,
  ) {
    try {
      const organizationId = this.getOrgId(req);
      if (!resourceType || !resourceId) {
        throw new HttpException(
          { success: false, message: 'resourceType and resourceId are required', error: 'MISSING_PARAMS' },
          HttpStatus.BAD_REQUEST,
        );
      }
      const data = await this.auditLogService.getResourceHistory(
        organizationId,
        resourceType,
        resourceId,
        limit ? parseInt(limit) : 50,
      );
      return { success: true, data };
    } catch (error) {
      throw new HttpException(
        { success: false, message: error.message, error: 'AUDIT_LOG_FETCH_FAILED' },
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
