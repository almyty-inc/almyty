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
import { WebSocketTransport } from '../transports/websocket.transport';
import { StreamableHttpTransport } from '../transports/streamable-http.transport';
import { McpService } from '../mcp.service';
import { JsonRpcRequest } from '../types/mcp.types';

@Controller('mcp')
export class McpTransportController {
  private readonly logger = new Logger(McpTransportController.name);

  constructor(
    private readonly mcpService: McpService,
    private readonly sseTransport: SseTransport,
    private readonly wsTransport: WebSocketTransport,
    private readonly streamable: StreamableHttpTransport,
  ) {}


  // Streamable HTTP endpoint (MCP 2025-03-26 revision). Single path
  // hosting both directions: POST is client->server, GET opens an SSE
  // stream for server->client. Sessions identified via Mcp-Session-Id
  // header; Last-Event-ID drives reconnect replay.
  @Post('/streamable')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('member', 'admin', 'owner')
  async streamablePost(@Request() req, @Response() res): Promise<void> {
    const organizationId = req.user?.currentOrganizationId;
    const userId = req.user?.id;
    if (!organizationId) {
      throw new HttpException('Organization context required', HttpStatus.BAD_REQUEST);
    }
    await this.streamable.handlePost(req, res, organizationId, userId);
  }

  @Get('/streamable')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('member', 'admin', 'owner')
  async streamableStream(@Request() req, @Response() res): Promise<void> {
    const organizationId = req.user?.currentOrganizationId;
    const userId = req.user?.id;
    if (!organizationId) {
      throw new HttpException('Organization context required', HttpStatus.BAD_REQUEST);
    }
    await this.streamable.handleStream(req, res, organizationId, userId);
  }
  // Server-Sent Events endpoint
  @Get('/sse')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('member', 'admin', 'owner')
  async handleSse(@Request() req, @Response() res, @Query('server') serverId?: string): Promise<void> {
    const organizationId = req.user?.currentOrganizationId;
    const userId = req.user?.id;

    if (!organizationId) {
      throw new HttpException('Organization context required', HttpStatus.BAD_REQUEST);
    }

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
  ): Promise<any> {
    const organizationId = req.user?.currentOrganizationId;

    if (!organizationId) {
      throw new HttpException('Organization context required', HttpStatus.BAD_REQUEST);
    }

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

    // Establish SSE connection for specific server
    await this.sseTransport.handleSseConnection(res, organizationId, userId, serverId);
  }

  // WebSocket endpoint (handled separately in gateway configuration)
  @Get('/ws/info')
  async getWebSocketInfo(): Promise<any> {
    return {
      // BASE_URL is the api host (https://api.almyty.com), whose ingress
      // routes '/' straight through with no rewrite -- only the *.almyty.app
      // and localhost dev hosts strip an '/api' prefix. So '/api/mcp/ws' on
      // BASE_URL was a 404 for every client that read this document.
      endpoint: `${process.env.BASE_URL || 'ws://localhost:4000'}/mcp/ws`,
      protocol: 'mcp-websocket',
      version: '1.0.0',
      features: {
        bidirectional: true,
        streaming: true,
        subscriptions: true,
        heartbeat: true,
      },
    };
  }

  // Transport statistics
  @Get('/transport/stats')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('member', 'admin', 'owner')
  async getTransportStats(@Request() req): Promise<any> {
    const organizationId = req.user?.currentOrganizationId;

    const sseStats = this.sseTransport.getConnectionStats();
    const wsStats = this.wsTransport.getConnectionStats();
    const sessionStats = await this.mcpService.getActiveSessions(organizationId);

    return {
      totalSessions: sessionStats.length,
      transports: {
        sse: {
          connections: sseStats.total,
          organizationConnections: sseStats.byOrganization[organizationId] || 0,
        },
        websocket: {
          connections: wsStats.total,
          organizationConnections: wsStats.byOrganization[organizationId] || 0,
        },
      },
      serverInfo: {
        name: 'almyty',
        version: '1.0.0',
        supportedTransports: ['http', 'sse', 'websocket'],
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
    @Body() broadcastData: { message: any; transport?: 'sse' | 'websocket' | 'all' },
  ): Promise<any> {
    const organizationId = req.user?.currentOrganizationId;

    if (!organizationId) {
      throw new HttpException('Organization context required', HttpStatus.BAD_REQUEST);
    }

    const { message, transport = 'all' } = broadcastData;
    let sseSent = 0;
    let wsSent = 0;

    if (transport === 'sse' || transport === 'all') {
      sseSent = await this.sseTransport.broadcast(organizationId, message);
    }

    if (transport === 'websocket' || transport === 'all') {
      wsSent = await this.wsTransport.broadcastToOrganization(organizationId, message);
    }

    return {
      message: 'Broadcast sent',
      recipients: {
        sse: sseSent,
        websocket: wsSent,
        total: sseSent + wsSent,
      },
    };
  }

  // Health check for transports. Previously this was a public
  // endpoint that dumped global connection counts (`sseStats.total`,
  // `wsStats.total`, averageAge, process.uptime). Those are
  // platform-wide reconnaissance data that regular tenants have
  // no business reading. Strip the response to a minimal liveness
  // shape so it can still answer a K8s probe without leaking
  // operational metrics. The full stats live behind /transport/stats
  // which is JWT-gated.
  @Get('/transport/health')
  async getTransportHealth(): Promise<any> {
    return {
      status: 'healthy',
      transports: {
        sse: { status: 'active' },
        websocket: { status: 'active' },
      },
    };
  }
}