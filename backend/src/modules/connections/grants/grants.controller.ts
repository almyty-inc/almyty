import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { RequirePermissions } from '../../../common/decorators/permissions.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { CONNECTIONS_READ } from '../connections.permissions';
import { CreateGrantDto } from './dto/grants.dto';
import { GrantsService } from './grants.service';

const validation = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });

function requireOrg(req: any): string {
  const organizationId = req.user?.currentOrganizationId;
  if (!organizationId) {
    throw new HttpException(
      { success: false, message: 'Organization context required. Multi-org users must send the X-Organization-Id header.', error: 'NO_ORGANIZATION' },
      HttpStatus.BAD_REQUEST,
    );
  }
  return organizationId;
}

/**
 * Grants on one connection. Route-level RBAC only checks membership
 * (`connections:read`); whether the caller may manage this particular
 * connection is the service's decision (docs/design/connections-grants.md).
 */
@ApiTags('Connections')
@ApiBearerAuth()
@Controller('connections/:id/grants')
@UseGuards(JwtAuthGuard, RolesGuard)
export class GrantsController {
  constructor(private readonly grants: GrantsService) {}

  @Get()
  @Roles('member', 'admin', 'owner')
  @RequirePermissions(CONNECTIONS_READ)
  @ApiOperation({ summary: 'List the grants on a connection' })
  async list(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const organizationId = requireOrg(req);
    const data = await this.grants.list(id, req.user, organizationId);
    return { success: true, data, message: 'Grants retrieved successfully' };
  }

  @Post()
  @Roles('member', 'admin', 'owner')
  @RequirePermissions(CONNECTIONS_READ)
  @ApiOperation({ summary: 'Grant a user, team, role, agent or workspace the use (or management) of a connection' })
  @UsePipes(validation)
  async create(@Request() req: any, @Param('id', ParseUUIDPipe) id: string, @Body() body: CreateGrantDto) {
    const organizationId = requireOrg(req);
    const data = await this.grants.grant(id, body, req.user, organizationId);
    return { success: true, data, message: 'Grant created successfully' };
  }

  @Delete(':grantId')
  @Roles('member', 'admin', 'owner')
  @RequirePermissions(CONNECTIONS_READ)
  @ApiOperation({ summary: 'Revoke a grant' })
  async revoke(@Request() req: any, @Param('id', ParseUUIDPipe) id: string, @Param('grantId', ParseUUIDPipe) grantId: string) {
    const organizationId = requireOrg(req);
    const data = await this.grants.revoke(grantId, req.user, organizationId);
    if (data.connectionId !== id) {
      throw new HttpException({ success: false, message: 'grant does not belong to this connection', error: 'GRANT_NOT_FOUND' }, HttpStatus.NOT_FOUND);
    }
    return { success: true, data, message: 'Grant revoked successfully' };
  }
}
