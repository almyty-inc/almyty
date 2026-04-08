import {
  Controller,
  Get,
  Param,
  Request,
  UseGuards,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { VersionsService } from './versions.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('versions')
@ApiTags('Versions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
export class VersionsController {
  constructor(private readonly versionsService: VersionsService) {}

  private requireOrg(req: any): string {
    const orgId = req.user?.currentOrganizationId;
    if (!orgId) {
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
    return orgId;
  }

  @Get(':entityType/:entityId')
  @Roles('viewer', 'member', 'admin', 'owner')
  async getVersions(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @Request() req: any,
  ) {
    try {
      const orgId = this.requireOrg(req);
      const versions = await this.versionsService.getVersions(entityType, entityId, orgId);
      return { success: true, data: versions };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('detail/:versionId')
  @Roles('viewer', 'member', 'admin', 'owner')
  async getVersion(@Param('versionId') versionId: string, @Request() req: any) {
    try {
      const orgId = this.requireOrg(req);
      const version = await this.versionsService.getVersion(parseInt(versionId, 10), orgId);
      if (!version) {
        throw new HttpException({ success: false, message: 'Version not found' }, HttpStatus.NOT_FOUND);
      }
      return { success: true, data: version };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
