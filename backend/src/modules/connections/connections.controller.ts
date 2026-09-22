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
  Query,
  Request,
  Res,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { ConnectorCatalogService } from './connector-catalog.service';
import { ConnectionsService } from './connections.service';
import { CONNECTIONS_MANAGE, CONNECTIONS_READ } from './connections.permissions';
import { CompleteConnectDto, ConnectBodyDto, CreateConnectorDto, ListConnectorsQueryDto, RotateBodyDto } from './dto/connections.dto';
import { ConnectorDefinition } from './connector.types';

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

function requestBase(req: any): string | undefined {
  const host = req?.headers?.host;
  if (!host) return undefined;
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] || req.protocol || 'https';
  return `${proto}://${host}`;
}

@ApiTags('Connections')
@ApiBearerAuth()
@Controller('connectors')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ConnectorsController {
  constructor(private readonly catalog: ConnectorCatalogService, private readonly connections: ConnectionsService) {}

  @Get()
  @Roles('viewer', 'member', 'admin', 'owner')
  @RequirePermissions(CONNECTIONS_READ)
  @ApiOperation({ summary: 'Connector catalog: built-in, provider-derived and this organization\'s custom connectors' })
  @UsePipes(validation)
  async list(@Request() req: any, @Query() query: ListConnectorsQueryDto) {
    const organizationId = requireOrg(req);
    const data = await this.connections.describeConnectors(organizationId, query.kind);
    return { success: true, data, message: 'Connectors retrieved successfully' };
  }

  @Post()
  @Roles('admin', 'owner')
  @RequirePermissions(CONNECTIONS_MANAGE)
  @ApiOperation({ summary: 'Define a custom connector (any OpenAI-compatible endpoint, MCP server, bucket)' })
  @UsePipes(validation)
  async create(@Request() req: any, @Body() body: CreateConnectorDto) {
    const organizationId = requireOrg(req);
    const data = await this.catalog.createCustom(organizationId, req.user.id, body as unknown as ConnectorDefinition);
    return { success: true, data, message: 'Connector created successfully' };
  }
}

@ApiTags('Connections')
@Controller('connections')
export class ConnectionsController {
  constructor(private readonly connections: ConnectionsService, private readonly configService: ConfigService) {}

  /**
   * Browser leg of a redirect connect. Unauthenticated by design: the
   * provider sends the user here, the state is the credential. Redirects
   * to the dashboard when FRONTEND_URL is set, else answers JSON.
   */
  @Get('oauth/callback')
  @ApiOperation({ summary: 'OAuth callback for connector sign-in' })
  async callback(@Query() query: Record<string, string>, @Res() res: Response) {
    const frontend = (this.configService.get<string>('FRONTEND_URL') || '').replace(/\/$/, '');
    try {
      const connection = await this.connections.handleCallback(query);
      if (frontend) return res.redirect(302, `${frontend}/connections?connection=${encodeURIComponent(connection.id)}&status=${encodeURIComponent(connection.health.status)}`);
      return res.status(200).json({ success: true, data: connection, message: 'Connected' });
    } catch (e: any) {
      const body = e instanceof HttpException ? e.getResponse() : { message: String(e?.message ?? e) };
      const status = e instanceof HttpException ? e.getStatus() : 500;
      const detail = typeof body === 'object' && body ? (body as any) : { message: String(body) };
      if (frontend) {
        const params = new URLSearchParams({ status: 'error', code: detail.code ?? 'CONNECT_FAILED', message: String(detail.message ?? '') });
        if (detail.connection?.id) params.set('connection', detail.connection.id);
        return res.redirect(302, `${frontend}/connections?${params.toString()}`);
      }
      return res.status(status).json({ success: false, ...detail });
    }
  }

  @Post('connect/:connectorKey')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @ApiBearerAuth()
  @Roles('member', 'admin', 'owner')
  @RequirePermissions(CONNECTIONS_READ)
  @ApiOperation({ summary: 'Start a connection: validates a form method live, or returns an authorize URL for OAuth' })
  @UsePipes(validation)
  async connect(@Request() req: any, @Param('connectorKey') connectorKey: string, @Body() body: ConnectBodyDto) {
    const organizationId = requireOrg(req);
    const data = await this.connections.connect(req.user, organizationId, connectorKey, body, requestBase(req));
    return { success: true, data, message: data.pending ? 'Connect pending' : 'Connected' };
  }

  @Post('connect/:connectorKey/complete')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @ApiBearerAuth()
  @Roles('member', 'admin', 'owner')
  @RequirePermissions(CONNECTIONS_READ)
  @ApiOperation({ summary: 'Headless completion: paste the code the provider printed' })
  @UsePipes(validation)
  async complete(@Request() req: any, @Param('connectorKey') _connectorKey: string, @Body() body: CompleteConnectDto) {
    requireOrg(req);
    const data = await this.connections.complete(body.state, body.code);
    return { success: true, data, message: 'Connected' };
  }

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @ApiBearerAuth()
  @Roles('viewer', 'member', 'admin', 'owner')
  @RequirePermissions(CONNECTIONS_READ)
  @ApiOperation({ summary: 'List connections (masked: account label, health, scopes; never values)' })
  async list(@Request() req: any) {
    const organizationId = requireOrg(req);
    const data = await this.connections.list(req.user, organizationId);
    return { success: true, data, message: 'Connections retrieved successfully' };
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @ApiBearerAuth()
  @Roles('viewer', 'member', 'admin', 'owner')
  @RequirePermissions(CONNECTIONS_READ)
  @ApiOperation({ summary: 'Get one connection (masked)' })
  async get(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const organizationId = requireOrg(req);
    const data = await this.connections.get(req.user, organizationId, id);
    return { success: true, data, message: 'Connection retrieved successfully' };
  }

  @Post(':id/validate')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @ApiBearerAuth()
  @Roles('member', 'admin', 'owner')
  @RequirePermissions(CONNECTIONS_READ)
  @ApiOperation({ summary: 'Re-run the connector validation; refreshes health and account label' })
  async validate(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const organizationId = requireOrg(req);
    const data = await this.connections.validate(req.user, organizationId, id);
    return { success: true, data, message: data.health.status === 'valid' ? 'Connection valid' : `Connection ${data.health.status}` };
  }

  @Post(':id/rotate')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @ApiBearerAuth()
  @Roles('member', 'admin', 'owner')
  @RequirePermissions(CONNECTIONS_READ)
  @ApiOperation({ summary: 'Rotate in place: returns the form (or a new authorize URL), then accepts the new values' })
  @UsePipes(validation)
  async rotate(@Request() req: any, @Param('id', ParseUUIDPipe) id: string, @Body() body: RotateBodyDto) {
    const organizationId = requireOrg(req);
    const data = await this.connections.rotate(req.user, organizationId, id, body, requestBase(req));
    return { success: true, data, message: data.pending ? 'Rotate pending' : 'Connection rotated' };
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @ApiBearerAuth()
  @Roles('member', 'admin', 'owner')
  @RequirePermissions(CONNECTIONS_READ)
  @ApiOperation({ summary: 'Disconnect: revokes at the provider when the connector declares a revoke endpoint, then deletes the row' })
  async disconnect(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const organizationId = requireOrg(req);
    const data = await this.connections.disconnect(req.user, organizationId, id);
    return { success: true, data, message: 'Disconnected' };
  }
}
