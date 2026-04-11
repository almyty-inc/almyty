import {
  Controller,
  Post,
  Body,
  Request,
  UseGuards,
  Headers,
  HttpException,
  HttpStatus,
  Logger,
  Get,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { McpService } from './mcp.service';
import { AlmytyMcpService } from './almyty-mcp.service';
import { JsonRpcRequest, JsonRpcResponse } from './types/mcp.types';

@Controller('mcp')
export class McpController {
  private readonly logger = new Logger(McpController.name);

  constructor(
    private readonly mcpService: McpService,
    private readonly almytyMcpService: AlmytyMcpService,
  ) {}

  // almyty platform MCP — management tools are now real Tool rows
  // served by the standard MCP infrastructure via the system gateway
  // (see SystemGatewayService). This endpoint forwards to McpService
  // for backward compatibility.
  @Post('almyty')
  @UseGuards(JwtAuthGuard)
  async handleAlmytyMcp(@Request() req, @Body() body: any): Promise<JsonRpcResponse> {
    return this.handleMcp(req, body);
  }

  @Get('almyty/.well-known/mcp')
  async almytyWellKnown(): Promise<any> {
    const baseUrl = process.env.BASE_URL || process.env.FRONTEND_URL || 'http://localhost:4000';
    return {
      protocol: 'mcp',
      version: '2024-11-05',
      server: { name: 'almyty', version: '1.0.0' },
      capabilities: { tools: { listChanged: true } },
      transports: { http: `${baseUrl}/mcp/almyty` },
    };
  }

  // Main MCP JSON-RPC Endpoint
  @Post()
  @UseGuards(JwtAuthGuard)
  async handleMcp(@Request() req, @Body() body: any): Promise<JsonRpcResponse> {
    const organizationId = req.user?.currentOrganizationId;
    const userId = req.user?.id;

    if (!organizationId) {
      throw new HttpException('Organization context required', HttpStatus.BAD_REQUEST);
    }

    return this.mcpService.handleJsonRpc(body, organizationId, userId);
  }

  // Root-level MCP endpoints (for compatibility)
  @Post('/initialize')
  @UseGuards(JwtAuthGuard)
  async initialize(@Request() req, @Body() body: any): Promise<JsonRpcResponse> {
    return this.handleMcp(req, {
      jsonrpc: '2.0',
      id: body.id || 1,
      method: 'initialize',
      params: body.params || body,
    });
  }

  @Post('/ping')
  @UseGuards(JwtAuthGuard)
  async ping(@Request() req, @Body() body: any): Promise<JsonRpcResponse> {
    return this.handleMcp(req, {
      jsonrpc: '2.0',
      id: body.id || 1,
      method: 'ping',
      params: body.params,
    });
  }

  @Post('/notifications')
  @UseGuards(JwtAuthGuard)
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
  @UseGuards(JwtAuthGuard)
  async listTools(@Request() req, @Body() body: any): Promise<JsonRpcResponse> {
    return this.handleMcp(req, {
      jsonrpc: '2.0',
      id: body.id || 1,
      method: 'tools/list',
      params: body.params,
    });
  }

  @Post('/tools/call')
  @UseGuards(JwtAuthGuard)
  async callTool(@Request() req, @Body() body: any): Promise<JsonRpcResponse> {
    return this.handleMcp(req, {
      jsonrpc: '2.0',
      id: body.id || 1,
      method: 'tools/call',
      params: body.params || body,
    });
  }

  // Progressive tool discovery endpoints
  @Post('/tools/discover')
  @UseGuards(JwtAuthGuard)
  async discoverTools(@Request() req, @Body() body: any): Promise<JsonRpcResponse> {
    return this.handleMcp(req, {
      jsonrpc: '2.0',
      id: body.id || 1,
      method: 'tools/discover',
      params: body.params || body,
    });
  }

  @Post('/tools/search')
  @UseGuards(JwtAuthGuard)
  async searchTools(@Request() req, @Body() body: any): Promise<JsonRpcResponse> {
    return this.handleMcp(req, {
      jsonrpc: '2.0',
      id: body.id || 1,
      method: 'tools/search',
      params: body.params || body,
    });
  }

  @Post('/tools/get')
  @UseGuards(JwtAuthGuard)
  async getToolDetails(@Request() req, @Body() body: any): Promise<JsonRpcResponse> {
    return this.handleMcp(req, {
      jsonrpc: '2.0',
      id: body.id || 1,
      method: 'tools/get',
      params: body.params || body,
    });
  }

  // Skills endpoints
  @Post('/skills/list')
  @UseGuards(JwtAuthGuard)
  async listSkills(@Request() req, @Body() body: any): Promise<JsonRpcResponse> {
    return this.handleMcp(req, {
      jsonrpc: '2.0',
      id: body.id || 1,
      method: 'skills/list',
      params: body.params || body,
    });
  }

  @Post('/skills/get')
  @UseGuards(JwtAuthGuard)
  async getSkill(@Request() req, @Body() body: any): Promise<JsonRpcResponse> {
    return this.handleMcp(req, {
      jsonrpc: '2.0',
      id: body.id || 1,
      method: 'skills/get',
      params: body.params || body,
    });
  }

  // Resources endpoints
  @Post('/resources/list')
  @UseGuards(JwtAuthGuard)
  async listResources(@Request() req, @Body() body: any): Promise<JsonRpcResponse> {
    return this.handleMcp(req, {
      jsonrpc: '2.0',
      id: body.id || 1,
      method: 'resources/list',
      params: body.params,
    });
  }

  @Post('/resources/read')
  @UseGuards(JwtAuthGuard)
  async readResource(@Request() req, @Body() body: any): Promise<JsonRpcResponse> {
    return this.handleMcp(req, {
      jsonrpc: '2.0',
      id: body.id || 1,
      method: 'resources/read',
      params: body.params || body,
    });
  }

  // Prompts endpoints
  @Post('/prompts/list')
  @UseGuards(JwtAuthGuard)
  async listPrompts(@Request() req, @Body() body: any): Promise<JsonRpcResponse> {
    return this.handleMcp(req, {
      jsonrpc: '2.0',
      id: body.id || 1,
      method: 'prompts/list',
      params: body.params,
    });
  }

  @Post('/prompts/get')
  @UseGuards(JwtAuthGuard)
  async getPrompt(@Request() req, @Body() body: any): Promise<JsonRpcResponse> {
    return this.handleMcp(req, {
      jsonrpc: '2.0',
      id: body.id || 1,
      method: 'prompts/get',
      params: body.params || body,
    });
  }

  // Health check for MCP service
  @Get('/health')
  async health(): Promise<any> {
    return this.mcpService.healthCheck();
  }

  // MCP server information
  @Get('/.well-known/mcp')
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
        tools: { listChanged: true },
        resources: { listChanged: true, subscribe: false },
        prompts: { listChanged: true },
        experimental: {
          almyty: {
            universalApiTranslation: true,
            multiProtocolSupport: ['mcp', 'utcp', 'a2a'],
            supportedApiFormats: ['openapi', 'graphql', 'soap', 'protobuf'],
          },
        },
      },
      transports: {
        http: `${process.env.BASE_URL || 'http://localhost:4000'}/api/mcp`,
        sse: `${process.env.BASE_URL || 'http://localhost:4000'}/api/mcp/sse`,
        websocket: `${process.env.BASE_URL || 'http://localhost:4000'}/api/mcp/ws`,
      },
    };
  }
}
