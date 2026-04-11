import {
  Controller,
  Post,
  Body,
  Request,
  UseGuards,
  Headers,
  HttpException,
  HttpStatus,
  HttpCode,
  Header,
  Logger,
  Get,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { McpService } from './mcp.service';
import { AlmytyMcpService } from './almyty-mcp.service';
import { McpOAuthService } from './services/mcp-oauth.service';
import { JsonRpcRequest, JsonRpcResponse } from './types/mcp.types';

@Controller('mcp')
export class McpController {
  private readonly logger = new Logger(McpController.name);

  constructor(
    private readonly mcpService: McpService,
    private readonly almytyMcpService: AlmytyMcpService,
    private readonly mcpOAuthService: McpOAuthService,
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
      capabilities: { tools: { listChanged: false } },
      transports: { http: `${baseUrl}/mcp/almyty` },
    };
  }

  @Get('almyty/.well-known/oauth-protected-resource')
  async almytyOAuthResource(): Promise<any> {
    const baseUrl = process.env.BASE_URL || process.env.FRONTEND_URL || 'http://localhost:4000';
    return {
      resource: `${baseUrl}/mcp/almyty`,
      authorization_servers: [`${baseUrl}/mcp/almyty`],
    };
  }

  @Get('almyty/.well-known/oauth-authorization-server')
  async almytyOAuthMetadata(): Promise<any> {
    const baseUrl = process.env.BASE_URL || process.env.FRONTEND_URL || 'http://localhost:4000';
    const prefix = `${baseUrl}/mcp/almyty`;
    return {
      issuer: prefix,
      authorization_endpoint: `${prefix}/authorize`,
      token_endpoint: `${prefix}/token`,
      registration_endpoint: `${prefix}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
      code_challenge_methods_supported: ['S256'],
    };
  }

  // OAuth for /mcp/almyty — dynamic client registration
  @Post('almyty/register')
  @HttpCode(HttpStatus.CREATED)
  @Header('Content-Type', 'application/json')
  async almytyRegister(@Body() body: any, @Res() res: Response) {
    if (!body.client_name || !body.redirect_uris?.length) {
      throw new HttpException({ error: 'invalid_client_metadata', error_description: 'client_name and redirect_uris required' }, HttpStatus.BAD_REQUEST);
    }
    const client = await this.mcpOAuthService.registerClient({
      clientName: body.client_name,
      redirectUris: body.redirect_uris,
      grantTypes: body.grant_types || ['authorization_code'],
      responseTypes: body.response_types || ['code'],
      tokenEndpointAuthMethod: body.token_endpoint_auth_method || 'none',
      gatewayId: 'almyty-platform',
    });
    return res.status(201).json(client);
  }

  // OAuth for /mcp/almyty — authorize (browser redirect)
  @Get('almyty/authorize')
  @Header('Cache-Control', 'no-store')
  async almytyAuthorize(
    @Query('response_type') responseType: string,
    @Query('client_id') clientId: string,
    @Query('redirect_uri') redirectUri: string,
    @Query('code_challenge') codeChallenge: string,
    @Query('code_challenge_method') codeChallengeMethod: string,
    @Query('scope') scope: string,
    @Query('state') state: string,
    @Req() req: any,
    @Res() res: Response,
  ) {
    if (!responseType || !clientId || !redirectUri || !codeChallenge) {
      throw new HttpException({ error: 'invalid_request' }, HttpStatus.BAD_REQUEST);
    }
    const user = req.user;
    if (!user) {
      const baseUrl = process.env.BASE_URL || 'http://localhost:4000';
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3002';
      const params = new URLSearchParams({ response_type: responseType, client_id: clientId, redirect_uri: redirectUri, code_challenge: codeChallenge, code_challenge_method: codeChallengeMethod || 'S256', ...(scope ? { scope } : {}), ...(state ? { state } : {}) });
      return res.redirect(302, `${frontendUrl}/auth/login?returnTo=${encodeURIComponent(`${baseUrl}/mcp/almyty/authorize?${params}`)}`);
    }
    const orgId = user.currentOrganizationId || user.organizations?.[0]?.id;
    const code = await this.mcpOAuthService.createAuthorizationCode({
      organizationId: orgId,
      gatewayId: 'almyty-platform',
      userId: user.id,
      clientId,
      redirectUri,
      codeChallenge,
      codeChallengeMethod: codeChallengeMethod || 'S256',
      scope: scope || 'mcp:*',
    });
    const url = new URL(redirectUri);
    url.searchParams.set('code', code);
    if (state) url.searchParams.set('state', state);
    return res.redirect(302, url.toString());
  }

  // OAuth for /mcp/almyty — token exchange
  @Post('almyty/token')
  @HttpCode(HttpStatus.OK)
  @Header('Content-Type', 'application/json')
  @Header('Cache-Control', 'no-store')
  async almytyToken(@Body() body: any) {
    if (body.grant_type === 'authorization_code') {
      return this.mcpOAuthService.exchangeCode({
        gatewayId: 'almyty-platform',
        code: body.code,
        redirectUri: body.redirect_uri,
        codeVerifier: body.code_verifier,
        clientId: body.client_id,
        clientSecret: body.client_secret,
      });
    }
    if (body.grant_type === 'refresh_token') {
      return this.mcpOAuthService.refreshToken({
        gatewayId: 'almyty-platform',
        refreshToken: body.refresh_token,
        clientId: body.client_id,
        clientSecret: body.client_secret,
      });
    }
    throw new HttpException({ error: 'unsupported_grant_type' }, HttpStatus.BAD_REQUEST);
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
