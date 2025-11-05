import {
  Controller,
  Get,
  Post,
  All,
  Req,
  Res,
  Param,
  Headers,
  Query,
  Body,
  Logger,
  HttpStatus,
  UseGuards,
  Inject,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ApiTags, ApiOperation, ApiResponse, ApiExcludeEndpoint } from '@nestjs/swagger';
import * as WebSocket from 'ws';

import { GatewayProtocolService, ProtocolRequest } from './gateway-protocol.service';
import { GatewayAuthService } from './gateway-auth.service';
import { GatewaysService } from './gateways.service';
import { Gateway } from '../../entities/gateway.entity';

@Controller('gateways')
@ApiTags('Gateway Protocols')
export class GatewayProtocolController {
  private readonly logger = new Logger(GatewayProtocolController.name);

  constructor(
    private readonly gatewayProtocolService: GatewayProtocolService,
    private readonly gatewayAuthService: GatewayAuthService,
    private readonly gatewaysService: GatewaysService,
  ) {}

  @All(':endpoint(*)')
  @ApiExcludeEndpoint() // Exclude from Swagger as this is a dynamic endpoint
  async handleGatewayRequest(
    @Param('endpoint') endpoint: string,
    @Req() req: Request,
    @Res() res: Response,
    @Headers() headers: Record<string, string>,
    @Query() query: Record<string, string>,
    @Body() body: any,
  ) {
    const startTime = Date.now();
    let gateway: Gateway | null = null;

    try {
      // Find gateway by endpoint
      gateway = await this.findGatewayByEndpoint(`/${endpoint}`);
      
      if (!gateway) {
        return res.status(404).json({
          error: {
            code: 'GATEWAY_NOT_FOUND',
            message: 'Gateway endpoint not found',
          },
        });
      }

      // Check if gateway can accept requests
      if (!gateway.canAcceptRequests()) {
        return res.status(503).json({
          error: {
            code: 'GATEWAY_UNAVAILABLE',
            message: 'Gateway is currently unavailable',
          },
        });
      }

      // Apply CORS if configured
      if (gateway.corsConfig) {
        this.applyCorsHeaders(res, gateway.corsConfig, req.headers.origin as string);
        
        // Handle preflight OPTIONS request
        if (req.method === 'OPTIONS') {
          return res.status(200).end();
        }
      }

      // Apply custom headers
      if (gateway.customHeaders) {
        Object.entries(gateway.customHeaders).forEach(([key, value]) => {
          res.setHeader(key, value);
        });
      }

      // Authenticate request
      const authResult = await this.gatewayAuthService.authenticateRequest(
        gateway.id,
        headers,
        query,
        body,
        this.getClientIp(req)
      );

      if (!authResult.isValid) {
        const authError = gateway.authConfigs?.[0]?.getErrorResponse('unauthorized') || {
          code: 401,
          message: authResult.error || 'Unauthorized',
        };

        return res.status(authError.code).json({
          error: {
            code: authResult.errorCode || 'UNAUTHORIZED',
            message: authError.message,
            details: authError.details,
          },
        });
      }

      // Create protocol request
      const protocolRequest: ProtocolRequest = {
        gatewayId: gateway.id,
        method: req.method,
        params: query,
        headers,
        query,
        body,
        userId: authResult.userId,
        userRoles: authResult.roles,
        userOrg: authResult.organizationId,
        scopes: authResult.scopes,
      };

      // Handle the protocol request
      const protocolResponse = await this.gatewayProtocolService.handleProtocolRequest(protocolRequest);

      // Update gateway request stats
      const success = protocolResponse.success;
      gateway.incrementRequest(success);
      await this.saveGatewayStats(gateway);

      // Set response based on protocol type and success
      const responseTime = Date.now() - startTime;
      
      if (protocolResponse.success) {
        // Set appropriate content type based on gateway type
        const contentType = this.getContentTypeForGateway(gateway);
        res.setHeader('Content-Type', contentType);
        
        // Add response time header
        res.setHeader('X-Response-Time', `${responseTime}ms`);
        
        // Add gateway metadata headers
        res.setHeader('X-Gateway-ID', gateway.id);
        res.setHeader('X-Gateway-Type', gateway.type);
        
        return res.status(200).json(protocolResponse.data || { success: true });
      } else {
        const errorCode = protocolResponse.error?.code || 'PROTOCOL_ERROR';
        const statusCode = this.getStatusCodeFromErrorCode(errorCode);
        
        return res.status(statusCode).json({
          error: protocolResponse.error,
        });
      }

    } catch (error) {
      this.logger.error(`Gateway request error: ${error.message}`, error.stack);
      
      // Update error stats if we have a gateway
      if (gateway) {
        gateway.incrementRequest(false);
        await this.saveGatewayStats(gateway);
      }

      return res.status(500).json({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error',
        },
      });
    }
  }

  @Get(':endpoint(*)/health')
  @ApiOperation({ summary: 'Gateway health check endpoint' })
  @ApiResponse({ status: 200, description: 'Gateway is healthy' })
  @ApiResponse({ status: 503, description: 'Gateway is unhealthy' })
  async healthCheck(
    @Param('endpoint') endpoint: string,
    @Res() res: Response,
  ) {
    try {
      const gateway = await this.findGatewayByEndpoint(`/${endpoint}`);
      
      if (!gateway) {
        return res.status(404).json({
          error: 'Gateway not found',
        });
      }

      const healthResult = await this.gatewaysService.performHealthCheck(
        gateway.id,
        gateway.organizationId
      );

      const status = healthResult.isHealthy ? 200 : 503;
      
      return res.status(status).json({
        healthy: healthResult.isHealthy,
        responseTime: healthResult.responseTime,
        details: healthResult.details,
        error: healthResult.error,
        gateway: {
          id: gateway.id,
          name: gateway.name,
          type: gateway.type,
          status: gateway.status,
        },
      });

    } catch (error) {
      this.logger.error(`Health check error: ${error.message}`);
      
      return res.status(500).json({
        healthy: false,
        error: 'Health check failed',
      });
    }
  }

  @Get(':endpoint(*)/info')
  @ApiOperation({ summary: 'Gateway information endpoint' })
  @ApiResponse({ status: 200, description: 'Gateway information retrieved' })
  async getGatewayInfo(
    @Param('endpoint') endpoint: string,
    @Res() res: Response,
  ) {
    try {
      const gateway = await this.findGatewayByEndpoint(`/${endpoint}`);
      
      if (!gateway) {
        return res.status(404).json({
          error: 'Gateway not found',
        });
      }

      const info = {
        name: gateway.name,
        description: gateway.description,
        type: gateway.type,
        version: '1.0.0',
        status: gateway.status,
        capabilities: gateway.getConfigForType(),
        supportedProtocols: this.getSupportedProtocols(gateway),
        activeTools: gateway.getActiveTools().length,
        authentication: gateway.authConfigs?.map(auth => ({
          type: auth.type,
          required: auth.isRequired,
        })) || [],
        rateLimit: gateway.rateLimitConfig,
        lastHealthCheck: gateway.lastHealthCheckAt,
        isHealthy: gateway.isHealthy,
      };

      return res.status(200).json(info);

    } catch (error) {
      this.logger.error(`Gateway info error: ${error.message}`);
      
      return res.status(500).json({
        error: 'Failed to get gateway info',
      });
    }
  }

  @Post(':endpoint(*)/sse')
  @ApiOperation({ summary: 'Server-Sent Events endpoint for MCP gateways' })
  @ApiResponse({ status: 200, description: 'SSE connection established' })
  async handleSSE(
    @Param('endpoint') endpoint: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const gateway = await this.findGatewayByEndpoint(`/${endpoint}`);
      
      if (!gateway) {
        return res.status(404).json({
          error: 'Gateway not found',
        });
      }

      if (!gateway.supportsProtocol('sse')) {
        return res.status(400).json({
          error: 'Gateway does not support Server-Sent Events',
        });
      }

      // Set SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');

      // Send initial connection event
      res.write(`data: ${JSON.stringify({
        type: 'connection',
        message: 'Connected to gateway',
        gatewayId: gateway.id,
        timestamp: new Date().toISOString(),
      })}\n\n`);

      // Keep connection alive with periodic heartbeat
      const heartbeatInterval = setInterval(() => {
        res.write(`data: ${JSON.stringify({
          type: 'heartbeat',
          timestamp: new Date().toISOString(),
        })}\n\n`);
      }, 30000); // Every 30 seconds

      // Handle client disconnect
      req.on('close', () => {
        clearInterval(heartbeatInterval);
        this.logger.log(`SSE client disconnected from gateway ${gateway.name}`);
      });

    } catch (error) {
      this.logger.error(`SSE error: ${error.message}`);
      res.status(500).json({
        error: 'SSE connection failed',
      });
    }
  }

  // WebSocket handling would be done at the application level with a WebSocket gateway
  // This is a placeholder for documentation
  @ApiOperation({ summary: 'WebSocket endpoint for MCP and A2A gateways' })
  @ApiResponse({ status: 101, description: 'WebSocket connection upgraded' })
  handleWebSocket() {
    // WebSocket connections are handled by the WebSocket gateway
    // See gateway-protocol.service.ts for WebSocket handling logic
  }

  private async findGatewayByEndpoint(endpoint: string): Promise<Gateway | null> {
    try {
      // Remove query parameters and fragments
      const cleanEndpoint = endpoint.split('?')[0].split('#')[0];
      
      return await this.gatewaysService['gatewayRepository'].findOne({
        where: { endpoint: cleanEndpoint },
        relations: ['tools', 'tools.tool', 'authConfigs'],
      });
    } catch (error) {
      this.logger.error(`Error finding gateway by endpoint: ${error.message}`);
      return null;
    }
  }

  private applyCorsHeaders(res: Response, corsConfig: any, origin?: string): void {
    if (corsConfig.origins.includes('*') || (origin && corsConfig.origins.includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin || '*');
    }
    
    if (corsConfig.methods?.length > 0) {
      res.setHeader('Access-Control-Allow-Methods', corsConfig.methods.join(', '));
    }
    
    if (corsConfig.allowedHeaders?.length > 0) {
      res.setHeader('Access-Control-Allow-Headers', corsConfig.allowedHeaders.join(', '));
    }
    
    if (corsConfig.credentials) {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
  }

  private getClientIp(req: Request): string {
    return (req.headers['x-forwarded-for'] as string)?.split(',')[0] ||
           req.headers['x-real-ip'] as string ||
           req.connection?.remoteAddress ||
           req.socket?.remoteAddress ||
           'unknown';
  }

  private getContentTypeForGateway(gateway: Gateway): string {
    switch (gateway.type) {
      case 'mcp':
        return 'application/json-rpc';
      case 'a2a':
        return 'application/json';
      case 'utcp':
        return 'application/json';
      // 'scoped_tool' was removed - scoping is handled via selective tool assignment
      default:
        return 'application/json';
    }
  }

  private getStatusCodeFromErrorCode(errorCode: string): number {
    const errorCodeMap: Record<string, number> = {
      'UNAUTHORIZED': 401,
      'FORBIDDEN': 403,
      'GATEWAY_NOT_FOUND': 404,
      'TOOL_NOT_FOUND': 404,
      'METHOD_NOT_FOUND': 404,
      'INVALID_REQUEST': 400,
      'INVALID_PARAMS': 400,
      'RATE_LIMITED': 429,
      'GATEWAY_UNAVAILABLE': 503,
      'INTERNAL_ERROR': 500,
      'EXECUTION_FAILED': 422,
      'PROTOCOL_ERROR': 422,
    };

    return errorCodeMap[errorCode] || 500;
  }

  private getSupportedProtocols(gateway: Gateway): string[] {
    const protocols = ['http'];
    
    switch (gateway.type) {
      case 'mcp':
        protocols.push('sse', 'websocket');
        break;
      case 'a2a':
        protocols.push('grpc', 'websocket');
        break;
      case 'utcp':
        protocols.push('tcp');
        break;
    }
    
    return protocols;
  }

  private async saveGatewayStats(gateway: Gateway): Promise<void> {
    try {
      await this.gatewaysService['gatewayRepository'].save(gateway);
    } catch (error) {
      this.logger.warn(`Failed to save gateway stats: ${error.message}`);
    }
  }
}

// WebSocket Gateway for handling WebSocket connections
// This would be implemented as a separate WebSocket gateway in NestJS
export class GatewayWebSocketGateway {
  private readonly logger = new Logger(GatewayWebSocketGateway.name);

  constructor(
    private readonly gatewayProtocolService: GatewayProtocolService,
    private readonly gatewayAuthService: GatewayAuthService,
  ) {}

  async handleConnection(client: WebSocket, request: Request): Promise<void> {
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const endpoint = url.pathname;
      const query = Object.fromEntries(url.searchParams);

      // Find gateway by endpoint
      const gateway = await this.findGatewayByEndpoint(endpoint);
      
      if (!gateway) {
        client.close(1003, 'Gateway not found');
        return;
      }

      // Handle WebSocket connection through protocol service
      await this.gatewayProtocolService.handleWebSocketConnection(
        gateway.id,
        client,
        query
      );

      this.logger.log(`WebSocket client connected to gateway ${gateway.name}`);

    } catch (error) {
      this.logger.error(`WebSocket connection error: ${error.message}`);
      client.close(1011, 'Internal server error');
    }
  }

  private async findGatewayByEndpoint(endpoint: string): Promise<Gateway | null> {
    // Implementation similar to the one in the controller
    // This would need access to the gateway repository
    return null; // Placeholder
  }
}