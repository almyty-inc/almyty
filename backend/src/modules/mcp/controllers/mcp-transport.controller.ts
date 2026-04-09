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
import { SseTransport } from '../transports/sse.transport';
import { WebSocketTransport } from '../transports/websocket.transport';
import { McpService } from '../mcp.service';
import { JsonRpcRequest } from '../types/mcp.types';

@Controller('mcp')
export class McpTransportController {
  private readonly logger = new Logger(McpTransportController.name);

  constructor(
    private readonly mcpService: McpService,
    private readonly sseTransport: SseTransport,
    private readonly wsTransport: WebSocketTransport,
  ) {}

  // Server-Sent Events endpoint
  @Get('/sse')
  @UseGuards(JwtAuthGuard)
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
  @UseGuards(JwtAuthGuard)
  async sendSseMessage(
    @Param('connectionId') connectionId: string,
    @Body() message: JsonRpcRequest,
    @Request() req,
  ): Promise<any> {
    const organizationId = req.user?.currentOrganizationId;

    if (!organizationId) {
      throw new HttpException('Organization context required', HttpStatus.BAD_REQUEST);
    }

    return this.sseTransport.handleSseMessage(connectionId, message);
  }

  // Server-specific SSE endpoints
  @Get('/servers/:serverId/sse')
  @UseGuards(JwtAuthGuard)
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
      endpoint: `${process.env.BASE_URL || 'ws://localhost:4000'}/api/mcp/ws`,
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
  @UseGuards(JwtAuthGuard)
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
  @UseGuards(JwtAuthGuard)
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