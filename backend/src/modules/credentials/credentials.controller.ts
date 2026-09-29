import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  UsePipes,
  ValidationPipe,
  Request,
  ParseUUIDPipe,
  HttpException,
  HttpStatus,
  Query,
  ForbiddenException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CredentialsService } from './credentials.service';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { findEffectiveMembership } from '../../common/authorization/membership';
import { ConnectionsService } from '../connections/connections.service';
import { ConnectorCatalogService } from '../connections/connector-catalog.service';
import { CONNECTIONS_MANAGE, CONNECTIONS_READ } from '../connections/connections.permissions';
import { CompleteConnectDto, ConnectBodyDto, CreateConnectorDto, ListConnectorsQueryDto, RotateBodyDto } from '../connections/dto/connections.dto';
import { ConnectorDefinition } from '../connections/connector.types';

const connectionValidation = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });

/** The origin a sign-in comes back to, from the request. */
function requestBase(req: any): string | undefined {
  const host = req?.headers?.host;
  if (!host) return undefined;
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] || req.protocol || 'https';
  return `${proto}://${host}`;
}
import {
  CreateCredentialDto,
  UpdateCredentialDto,
  CreateAccessKeyDto,
} from './dto/credentials.dto';

@Controller()
@ApiTags('Credentials')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
export class CredentialsController {
  constructor(
    private readonly credentialsService: CredentialsService,
    private readonly moduleRef: ModuleRef,
  ) {}

  // Extract the caller's current org and reject multi-org users who
  // didn't send an X-Organization-Id header. Previously this controller
  // silently read `req.user.organizations?.[0]?.id`, meaning a user in
  // two orgs would always operate on the alphabetically-first org —
  // including reading/writing AES-encrypted credential blobs — without
  // any indication that the requested org was ignored.
  private requireOrg(req: any): string {
    const organizationId = req.user?.currentOrganizationId;
    if (!organizationId) {
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
    return organizationId;
  }

  // ──────────────────────────────────────────────
  // Credentials: every key, token and account the org keeps.
  //
  // A credential made through a service (a "connection" in the code) is
  // added, checked, replaced and deleted here; its grants are on
  // GrantsController and the sign-in callback on CredentialSignInController.
  // The fixed paths come before `:id` (route-shadowing.guard.spec.ts).
  // ──────────────────────────────────────────────

  private connectionsService(): ConnectionsService {
    return this.moduleRef.get(ConnectionsService, { strict: false });
  }

  @Get('credentials/services')
  @Roles('viewer', 'member', 'admin', 'owner')
  @RequirePermissions(CONNECTIONS_READ)
  @ApiOperation({ summary: 'The services a credential can be added for: built-in, provider-derived and this organization\'s own' })
  @UsePipes(connectionValidation)
  async listServices(@Request() req: any, @Query() query: ListConnectorsQueryDto) {
    const organizationId = this.requireOrg(req);
    const data = await this.connectionsService().describeConnectors(organizationId, query.kind);
    return { success: true, data, message: 'Services retrieved successfully' };
  }

  @Post('credentials/services')
  @Roles('admin', 'owner')
  @RequirePermissions(CONNECTIONS_MANAGE)
  @ApiOperation({ summary: 'Define a custom service (any OpenAI-compatible endpoint, MCP server, bucket)' })
  @UsePipes(connectionValidation)
  async createService(@Request() req: any, @Body() body: CreateConnectorDto) {
    const organizationId = this.requireOrg(req);
    const catalog = this.moduleRef.get(ConnectorCatalogService, { strict: false });
    const data = await catalog.createCustom(organizationId, req.user.id, body as unknown as ConnectorDefinition);
    return { success: true, data, message: 'Service created successfully' };
  }

  @Post('credentials/connect/:connectorKey')
  @Roles('member', 'admin', 'owner')
  @RequirePermissions(CONNECTIONS_READ)
  @ApiOperation({ summary: 'Add a credential for a service: checks a key live, or returns an authorize URL for a sign-in' })
  @UsePipes(connectionValidation)
  async connect(@Request() req: any, @Param('connectorKey') connectorKey: string, @Body() body: ConnectBodyDto) {
    const organizationId = this.requireOrg(req);
    const data = await this.connectionsService().connect(req.user, organizationId, connectorKey, body, requestBase(req));
    return { success: true, data, message: data.pending ? 'Sign-in pending' : 'Credential added' };
  }

  @Post('credentials/connect/:connectorKey/complete')
  @Roles('member', 'admin', 'owner')
  @RequirePermissions(CONNECTIONS_READ)
  @ApiOperation({ summary: 'Finish a sign-in with the code the service showed' })
  @UsePipes(connectionValidation)
  async completeConnect(@Request() req: any, @Param('connectorKey') _connectorKey: string, @Body() body: CompleteConnectDto) {
    this.requireOrg(req);
    const data = await this.connectionsService().complete(body.state, body.code);
    return { success: true, data, message: 'Credential added' };
  }

  /**
   * Every credential: the ones added for a service carry what the service
   * says (its name, the account, whether it works, who owns it), the keys a
   * single API, MCP server, channel or app keeps are listed as they are.
   * Secret values never appear.
   */
  @Get('credentials')
  @Roles('viewer', 'member', 'admin', 'owner')
  @ApiOperation({ summary: 'List every credential of the organization (masked)' })
  @ApiResponse({ status: 200, description: 'Credentials retrieved successfully' })
  async findAll(@Request() req: any) {
    const organizationId = this.requireOrg(req);
    const [rows, views] = await Promise.all([
      this.credentialsService.findAll({ id: req.user.id }, organizationId),
      this.connectionsService().list(req.user, organizationId).catch(() => []),
    ]);
    const byId = new Map<string, any>(views.map((v: any) => [v.id, v] as [string, any]));
    const data = rows.map((row: any) => (row.connectorKey && byId.has(row.id) ? { ...row, ...byId.get(row.id) } : row));
    return { success: true, data, message: 'Credentials retrieved successfully' };
  }

  @Post('credentials')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Create a new credential' })
  @ApiResponse({ status: 201, description: 'Credential created successfully' })
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  async create(@Body() body: CreateCredentialDto, @Request() req: any) {
    const organizationId = this.requireOrg(req);
    const data = await this.credentialsService.create(body, organizationId, req.user.id);
    return { success: true, data, message: 'Credential created successfully' };
  }

  @Get('credentials/:id')
  @Roles('viewer', 'member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get a credential by ID (masked)' })
  @ApiResponse({ status: 200, description: 'Credential retrieved successfully' })
  async findById(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    const organizationId = this.requireOrg(req);
    const row: any = await this.credentialsService.findById(id, organizationId, { id: req.user.id });
    const data = row.connectorKey ? { ...row, ...(await this.connectionsService().get(req.user, organizationId, id)) } : row;
    return { success: true, data, message: 'Credential retrieved successfully' };
  }

  @Patch('credentials/:id')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Update a credential' })
  @ApiResponse({ status: 200, description: 'Credential updated successfully' })
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateCredentialDto,
    @Request() req: any,
  ) {
    const organizationId = this.requireOrg(req);
    const data = await this.credentialsService.update(id, body, organizationId, req.user.id);
    return { success: true, data, message: 'Credential updated successfully' };
  }

  /**
   * Delete a credential. One added for a service is disconnected (revoked
   * at the service first when it can be) by whoever may manage it; a key
   * an API, server, channel or app keeps is deleted by an admin.
   */
  @Delete('credentials/:id')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Delete a credential' })
  @ApiResponse({ status: 200, description: 'Credential deleted successfully' })
  async delete(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    const organizationId = this.requireOrg(req);
    const row: any = await this.credentialsService.findById(id, organizationId, { id: req.user.id });
    if (row.connectorKey) {
      const data = await this.connectionsService().disconnect(req.user, organizationId, id);
      return { success: true, data, message: 'Credential deleted successfully' };
    }
    const role = findEffectiveMembership<any>(req.user?.organizationMemberships, organizationId)?.role;
    if (role !== 'admin' && role !== 'owner') throw new ForbiddenException('Insufficient role privileges');
    await this.credentialsService.delete(id, organizationId, req.user.id);
    return { success: true, data: null, message: 'Credential deleted successfully' };
  }

  @Post('credentials/:id/validate')
  @Roles('member', 'admin', 'owner')
  @RequirePermissions(CONNECTIONS_READ)
  @ApiOperation({ summary: 'Check a credential with its service again; refreshes whether it works and the account' })
  async validate(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const organizationId = this.requireOrg(req);
    const data = await this.connectionsService().validate(req.user, organizationId, id);
    return { success: true, data, message: data.health.status === 'valid' ? 'Credential works' : `Credential ${data.health.status}` };
  }

  @Post('credentials/:id/rotate')
  @Roles('member', 'admin', 'owner')
  @RequirePermissions(CONNECTIONS_READ)
  @ApiOperation({ summary: 'Replace the key in place: returns the form (or a new authorize URL), then takes the new values' })
  @UsePipes(connectionValidation)
  async rotate(@Request() req: any, @Param('id', ParseUUIDPipe) id: string, @Body() body: RotateBodyDto) {
    const organizationId = this.requireOrg(req);
    const data = await this.connectionsService().rotate(req.user, organizationId, id, body, requestBase(req));
    return { success: true, data, message: data.pending ? 'Replace pending' : 'Key replaced' };
  }

  @Post('credentials/:id/test')

  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Test a credential connection' })
  @ApiResponse({ status: 200, description: 'Credential test completed' })
  async test(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    // Verify the credential exists in the caller's org before reporting.
    // Without this the endpoint would return success for any UUID,
    // acting as a membership oracle for other orgs' credential ids.
    const organizationId = this.requireOrg(req);
    await this.credentialsService.findById(id, organizationId, { id: req.user.id });
    return { success: true, data: { valid: true }, message: 'Credential test passed' };
  }

  @Get('credentials/:id/usage')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get usage info for a credential' })
  @ApiResponse({ status: 200, description: 'Credential usage retrieved successfully' })
  async getUsage(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    const organizationId = this.requireOrg(req);
    const data = await this.credentialsService.getUsage(id, organizationId, { id: req.user.id });
    return { success: true, data, message: 'Credential usage retrieved successfully' };
  }

  // ──────────────────────────────────────────────
  // Inbound access keys
  // ──────────────────────────────────────────────

  @Get('access-keys')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'List all access keys for the organization' })
  @ApiResponse({ status: 200, description: 'Access keys retrieved successfully' })
  async findAllAccessKeys(@Request() req: any) {
    const organizationId = this.requireOrg(req);
    const data = await this.credentialsService.findAllAccessKeys(organizationId, { id: req.user.id });
    return { success: true, data, message: 'Access keys retrieved successfully' };
  }

  @Post('access-keys')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Create a new access key' })
  @ApiResponse({ status: 201, description: 'Access key created successfully' })
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  async createAccessKey(@Body() body: CreateAccessKeyDto, @Request() req: any) {
    const organizationId = this.requireOrg(req);
    const userId = req.user.id;
    const { key, plainTextKey } = await this.credentialsService.createAccessKey(
      body,
      organizationId,
      userId,
    );
    return {
      success: true,
      data: { ...key, plainTextKey },
      message: 'Access key created successfully. Store the key securely — it will not be shown again.',
    };
  }

  @Delete('access-keys/:id')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Revoke an access key' })
  @ApiResponse({ status: 200, description: 'Access key revoked successfully' })
  async revokeAccessKey(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    const organizationId = this.requireOrg(req);
    await this.credentialsService.revokeAccessKey(id, organizationId);
    return { success: true, data: null, message: 'Access key revoked successfully' };
  }
}
