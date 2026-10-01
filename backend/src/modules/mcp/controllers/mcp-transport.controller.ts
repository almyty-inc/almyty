import {
  Controller,
  Get,
  Post,
  Body,
  Request,
  Response,
  UseGuards,
  Param,
  Query,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { SseTransport } from '../transports/sse.transport';
import { setLegacySseDeprecationHeaders } from '../core/legacy-sse-deprecation';
import { McpService } from '../mcp.service';
import { JsonRpcRequest } from '../types/mcp.types';

@Controller('mcp')
export class McpTransportController {
  private readonly logger = new Logger(McpTransportController.name);

  constructor(
    private readonly mcpService: McpService,
    private readonly sseTransport: SseTransport,
  ) {}

  // The Streamable HTTP session transport that used to live at
  // /mcp/streamable is the runner's worker stream now
  // (runner/transport/worker-stream.controller.ts, which keeps that path
  // for envelopes for one runner release). MCP itself is served statelessly
  // by gateways and POST /mcp.
  // Server-Sent Events endpoint: the legacy HTTP+SSE transport (2024-11-05),
  // deprecated in MCP 2026-07-28 (SEP-2596). Still served, and every response
  // on these three routes carries Deprecation and Link headers (RFC 9745,
  // core/legacy-sse-deprecation.ts). It goes once the request log shows no use.
  @Get('/sse')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('member', 'admin', 'owner')
  async handleSse(@Request() req, @Response() res, @Query('server') serverId?: string): Promise<void> {
    const organizationId = req.user?.currentOrganizationId;
    const userId = req.user?.id;

    if (!organizationId) {
      throw new HttpException('Organization context required', HttpStatus.BAD_REQUEST);
    }

    setLegacySseDeprecationHeaders(res);
    // Establish SSE connection
    await this.sseTransport.handleSseConnection(res, organizationId, userId, serverId);
  }

  // SSE message posting endpoint (for bidirectional communication)
  @Post('/sse/:connectionId/message')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('member', 'admin', 'owner')
  async sendSseMessage(
    @Param('connectionId') connectionId: string,
    @Body() message: JsonRpcRequest,
    @Request() req,
    @Response({ passthrough: true }) res,
  ): Promise<any> {
    const organizationId = req.user?.currentOrganizationId;

    if (!organizationId) {
      throw new HttpException('Organization context required', HttpStatus.BAD_REQUEST);
    }

    setLegacySseDeprecationHeaders(res);
    return this.sseTransport.handleSseMessage(connectionId, message, organizationId, req.user?.id);
  }

  // Server-specific SSE endpoints
  @Get('/servers/:serverId/sse')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('member', 'admin', 'owner')
  async handleServerSse(
    @Param('serverId') serverId: string,
    @Request() req,
    @Response() res,
  ): Promise<void> {
    const organizationId = req.user?.currentOrganizationId;
    const userId = req.user?.id;

    if (!organizationId) {
      throw new HttpException('Organization context required', HttpStatus.BAD_REQUEST);
    }

    setLegacySseDeprecationHeaders(res);
    // Establish SSE connection for specific server
    await this.sseTransport.handleSseConnection(res, organizationId, userId, serverId);
  }

  // Transport statistics for the caller's organization.
  //
  // This returned the platform-wide connection totals of every transport
  // next to the organization's own counts, to any member: how busy every
  // other tenant was, on a route guarded as tenant-scoped. Only the
  // caller's organization is counted now.
  @Get('/transport/stats')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('member', 'admin', 'owner')
  async getTransportStats(@Request() req): Promise<any> {
    const organizationId = req.user?.currentOrganizationId;
    if (!organizationId) {
      throw new HttpException('Organization context required', HttpStatus.BAD_REQUEST);
    }

    const sseStats = this.sseTransport.getConnectionStats();
    const sessionStats = await this.mcpService.getActiveSessions(organizationId);

    return {
      totalSessions: sessionStats.length,
      transports: {
        sse: {
          organizationConnections: sseStats.byOrganization[organizationId] || 0,
        },
      },
      serverInfo: {
        name: 'almyty',
        version: '1.0.0',
        supportedTransports: ['http', 'sse'],
        // HTTP+SSE (2024-11-05) is deprecated in MCP 2026-07-28 and goes
        // once the request log shows nobody uses it.
        deprecatedTransports: ['sse'],
      },
    };
  }

  // Broadcast message to organization
  @Post('/broadcast')
  @UseGuards(JwtAuthGuard, RolesGuard)
  // Fans an arbitrary message out to every MCP session in the org. There is no
  // dashboard sibling to mirror, and it is an operator action rather than a
  // tenant-user one, so it sits at admin+ -- one step above the member+ the
  // rest of this controller uses.
  @Roles('admin', 'owner')
  async broadcast(
    @Request() req,
    @Body() broadcastData: { message: any },
  ): Promise<any> {
    const organizationId = req.user?.currentOrganizationId;

    if (!organizationId) {
      throw new HttpException('Organization context required', HttpStatus.BAD_REQUEST);
    }

    const sseSent = await this.sseTransport.broadcast(organizationId, broadcastData.message);

    return {
      message: 'Broadcast sent',
      recipients: {
        sse: sseSent,
        total: sseSent,
      },
    };
  }

  // Health check for transports. Previously this was a public
  // endpoint that dumped global connection counts (`sseStats.total`,
  // averageAge, process.uptime). Those are platform-wide
  // reconnaissance data that regular tenants have no business
  // reading. Strip the response to a minimal liveness shape so it
  // can still answer a K8s probe without leaking operational metrics.
  @Get('/transport/health')
  async getTransportHealth(): Promise<any> {
    return {
      status: 'healthy',
      transports: {
        sse: { status: 'active' },
      },
    };
  }
}
