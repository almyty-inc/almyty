import {
  Controller,
  Post,
  Body,
  Request,
  Res,
  UseGuards,
  HttpException,
  HttpStatus,
  Get,
} from '@nestjs/common';
import { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { McpService } from './mcp.service';
import {
  mcpOriginRefusal,
  mcpOutcomeOf,
  recordMcpRequest,
  resolveMcpRequestVersion,
} from './core/mcp-http-binding';
import { mcpProtocolSettings } from './core/mcp-settings';
import { setProtocolContext } from '../../common/interceptors/protocol-context';

// Every authenticated route here carries RolesGuard AND an explicit @Roles.
// The guard alone is inert: RolesGuard returns true when neither @Roles nor
// @Permissions is present, so the decorator is the gate. This surface used to
// be JwtAuthGuard-only, which meant a `viewer` -- whose whole permission set
// is ['read', 'connections:read'] -- could POST /mcp with method
// 'tools/call' and execute any tool in the org: reaching the third-party
// APIs those tools front, with the org's stored credentials, on the org's
// bill. The roles chosen mirror the dashboard equivalent,
// tools.controller.ts, which gates list, read and execute alike at member+.
// /health and /.well-known/mcp stay unauthenticated on purpose.
//
// The per-method REST routes that used to sit here (/mcp/tools/list,
// /mcp/tools/call, ...) are gone (design doc, decision 4): nothing called
// them, and each was a second door onto the protocol with none of the
// core's version, Origin or batch rules.
@Controller('mcp')
export class McpController {
  constructor(
    private readonly mcpService: McpService,
  ) {}

  /**
   * The gateway-less org MCP endpoint (the stdio proxy's upstream when no
   * gateway is configured). Same core, same HTTP rules as a tenant gateway.
   */
  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('member', 'admin', 'owner')
  async handleMcp(
    @Request() req,
    @Body() body: any,
    @Res() res: Response,
  ): Promise<Response> {
    const organizationId = req.user?.currentOrganizationId;
    const userId = req.user?.id;

    if (!organizationId) {
      throw new HttpException('Organization context required', HttpStatus.BAD_REQUEST);
    }
    setProtocolContext(req, { organizationId, protocol: 'mcp' });

    const refusal = mcpOriginRefusal(req);
    if (refusal) {
      recordMcpRequest(req, null, body, 'refused');
      return res.status(refusal.status).json(refusal.body);
    }
    const resolution = resolveMcpRequestVersion(req, body);
    if ('refusal' in resolution) {
      recordMcpRequest(req, null, body, 'refused');
      return res.status(resolution.refusal.status).json(resolution.refusal.body);
    }

    const result = await this.mcpService.handleJsonRpcMessage(body, organizationId, userId, undefined, resolution.ctx);
    recordMcpRequest(req, resolution.ctx, body, mcpOutcomeOf(result));
    if (result === null) return res.status(202).end();
    return res.json(result);
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
    const supportedVersions = mcpProtocolSettings().supportedVersions;
    return {
      protocol: 'mcp',
      // The newest version answered, and every version answered.
      version: supportedVersions[0],
      supportedVersions,
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
