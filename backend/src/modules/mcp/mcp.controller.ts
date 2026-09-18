import {
  Controller,
  Post,
  Body,
  Request,
  UseGuards,
  HttpException,
  HttpStatus,
  Logger,
  Get,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { McpService } from './mcp.service';
import { JsonRpcResponse } from './types/mcp.types';

// Every authenticated route here carries RolesGuard AND an explicit @Roles.
// The guard alone is inert: RolesGuard returns true when neither @Roles nor
// @Permissions is present, so the decorator is the gate. This surface used to
// be JwtAuthGuard-only, which meant a `viewer` -- whose whole permission set
// is ['read', 'connections:read'] -- could POST /mcp/tools/call, or POST /mcp
// with method 'tools/call', and execute any tool in the org: reaching the
// third-party APIs those tools front, with the org's stored credentials, on
// the org's bill. The roles chosen mirror the dashboard equivalent,
// tools.controller.ts, which gates list, read and execute alike at member+.
// /health and /.well-known/mcp stay unauthenticated on purpose.
@Controller('mcp')
export class McpController {
  private readonly logger = new Logger(McpController.name);

  constructor(
    private readonly mcpService: McpService,
  ) {}

  // Main MCP JSON-RPC Endpoint
  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('member', 'admin', 'owner')
  async handleMcp(
    @Request() req,
    @Body() body: any,
  ): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
    const organizationId = req.user?.currentOrganizationId;
    const userId = req.user?.id;

    if (!organizationId) {
      throw new HttpException('Organization context required', HttpStatus.BAD_REQUEST);
    }

    // `handleJsonRpcMessage`, not `handleJsonRpc`: the body may be a
    // JSON-RPC batch, which the revision `initialize` negotiates for a
    // modern client (2025-03-26) requires the server to accept.
    return this.mcpService.handleJsonRpcMessage(body, organizationId, userId);
  }

  /**
   * The REST-style convenience routes below each synthesise one JSON-RPC
   * message, so they go through the single-message path directly rather
   * than through the batch-aware endpoint above.
   */
  private dispatchOne(req: any, message: any): Promise<JsonRpcResponse> {
    const organizationId = req.user?.currentOrganizationId;
    const userId = req.user?.id;

    if (!organizationId) {
      throw new HttpException('Organization context required', HttpStatus.BAD_REQUEST);
    }

    return this.mcpService.handleJsonRpc(message, organizationId, userId);
  }

  // Root-level MCP endpoints (for compatibility)
  @Post('/initialize')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('member', 'admin', 'owner')
  async initialize(@Request() req, @Body() body: any): Promise<JsonRpcResponse> {
    return this.dispatchOne(req, {
      jsonrpc: '2.0',
      id: body.id ?? 1,
      method: 'initialize',
      params: body.params || body,
    });
  }

  @Post('/ping')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('member', 'admin', 'owner')
  async ping(@Request() req, @Body() body: any): Promise<JsonRpcResponse> {
    return this.dispatchOne(req, {
      jsonrpc: '2.0',
      id: body.id ?? 1,
      method: 'ping',
      params: body.params,
    });
  }

  @Post('/notifications')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('member', 'admin', 'owner')
  async handleNotifications(@Request() req, @Body() body: any): Promise<void> {
    const organizationId = req.user?.currentOrganizationId;

    if (!organizationId) {
      throw new HttpException('Organization context required', HttpStatus.BAD_REQUEST);
    }

    // Handle MCP notifications
    this.logger.debug(`MCP notification: ${body.method} from user ${req.user.id}`);

    // Delegate to notification handling logic
    // For now, just log - we can enhance this later
  }

  // Tools endpoints (REST-style for easier integration)
  @Post('/tools/list')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('member', 'admin', 'owner')
  async listTools(@Request() req, @Body() body: any): Promise<JsonRpcResponse> {
    return this.dispatchOne(req, {
      jsonrpc: '2.0',
      id: body.id ?? 1,
      method: 'tools/list',
      params: body.params,
    });
  }

  @Post('/tools/call')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('member', 'admin', 'owner')
  async callTool(@Request() req, @Body() body: any): Promise<JsonRpcResponse> {
    return this.dispatchOne(req, {
      jsonrpc: '2.0',
      id: body.id ?? 1,
      method: 'tools/call',
      params: body.params || body,
    });
  }

  // Progressive tool discovery endpoints
  @Post('/tools/discover')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('member', 'admin', 'owner')
  async discoverTools(@Request() req, @Body() body: any): Promise<JsonRpcResponse> {
    return this.dispatchOne(req, {
      jsonrpc: '2.0',
      id: body.id ?? 1,
      method: 'tools/discover',
      params: body.params || body,
    });
  }

  @Post('/tools/search')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('member', 'admin', 'owner')
  async searchTools(@Request() req, @Body() body: any): Promise<JsonRpcResponse> {
    return this.dispatchOne(req, {
      jsonrpc: '2.0',
      id: body.id ?? 1,
      method: 'tools/search',
      params: body.params || body,
    });
  }

  @Post('/tools/get')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('member', 'admin', 'owner')
  async getToolDetails(@Request() req, @Body() body: any): Promise<JsonRpcResponse> {
    return this.dispatchOne(req, {
      jsonrpc: '2.0',
      id: body.id ?? 1,
      method: 'tools/get',
      params: body.params || body,
    });
  }

  // Skills endpoints
  @Post('/skills/list')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('member', 'admin', 'owner')
  async listSkills(@Request() req, @Body() body: any): Promise<JsonRpcResponse> {
    return this.dispatchOne(req, {
      jsonrpc: '2.0',
      id: body.id ?? 1,
      method: 'skills/list',
      params: body.params || body,
    });
  }

  @Post('/skills/get')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('member', 'admin', 'owner')
  async getSkill(@Request() req, @Body() body: any): Promise<JsonRpcResponse> {
    return this.dispatchOne(req, {
      jsonrpc: '2.0',
      id: body.id ?? 1,
      method: 'skills/get',
      params: body.params || body,
    });
  }

  // Resources endpoints
  @Post('/resources/list')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('member', 'admin', 'owner')
  async listResources(@Request() req, @Body() body: any): Promise<JsonRpcResponse> {
    return this.dispatchOne(req, {
      jsonrpc: '2.0',
      id: body.id ?? 1,
      method: 'resources/list',
      params: body.params,
    });
  }

  @Post('/resources/read')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('member', 'admin', 'owner')
  async readResource(@Request() req, @Body() body: any): Promise<JsonRpcResponse> {
    return this.dispatchOne(req, {
      jsonrpc: '2.0',
      id: body.id ?? 1,
      method: 'resources/read',
      params: body.params || body,
    });
  }

  // Prompts endpoints
  @Post('/prompts/list')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('member', 'admin', 'owner')
  async listPrompts(@Request() req, @Body() body: any): Promise<JsonRpcResponse> {
    return this.dispatchOne(req, {
      jsonrpc: '2.0',
      id: body.id ?? 1,
      method: 'prompts/list',
      params: body.params,
    });
  }

  @Post('/prompts/get')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('member', 'admin', 'owner')
  async getPrompt(@Request() req, @Body() body: any): Promise<JsonRpcResponse> {
    return this.dispatchOne(req, {
      jsonrpc: '2.0',
      id: body.id ?? 1,
      method: 'prompts/get',
      params: body.params || body,
    });
  }

  // Health check for MCP service
  @Get('/health')
  async health(): Promise<any> {
    return this.mcpService.healthCheck();
  }

  /**
   * Human-facing discovery document. This is not a spec-defined path, so
   * nothing machine-reads it — which is exactly why it has to be true: it
   * misleads people rather than SDKs.
   *
   * `listChanged` is false everywhere, matching McpService's negotiated
   * capability set. It advertised `true` here, which was doubly false:
   * the handshake says false, and `McpService.broadcastNotification`
   * writes a debug log and sends nothing, so no list-changed notification
   * has ever left this server.
   */
  @Get('/.well-known/mcp')
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  async wellKnown(): Promise<any> {
    return {
      protocol: 'mcp',
      version: '2024-11-05',
      server: {
        name: 'almyty',
        version: '1.0.0',
        description: 'Universal API-to-AI Tool Translation Platform',
      },
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false, subscribe: false },
        prompts: { listChanged: false },
        experimental: {
          almyty: {
            universalApiTranslation: true,
            multiProtocolSupport: ['mcp', 'utcp', 'a2a'],
            supportedApiFormats: ['openapi', 'graphql', 'soap', 'protobuf'],
          },
        },
      },
      // No `/api` segment: BASE_URL already names the API origin
      // (`https://api.almyty.com`), whose ingress routes `/` straight to
      // this service with no rewrite, so `${BASE_URL}/api/mcp` resolved to
      // a path Express has no route for. `/api` is a same-origin prefix a
      // tenant host uses and the ingress strips before this server sees
      // it — it is not part of any URL this server hands out here.
      //
      // `http` and `sse` are the MCP HTTP+SSE transport of the revision
      // named in `version`. `websocket` is NOT an MCP transport: no MCP
      // revision defines one, and almyty's WebSocket endpoint wraps
      // JSON-RPC in its own envelope. It is listed here for the clients
      // that use it, not as a claim of MCP conformance.
      transports: {
        http: `${process.env.BASE_URL || 'http://localhost:4000'}/mcp`,
        sse: `${process.env.BASE_URL || 'http://localhost:4000'}/mcp/sse`,
        websocket: `${process.env.BASE_URL || 'http://localhost:4000'}/mcp/ws`,
      },
    };
  }
}
