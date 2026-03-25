import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Req,
  Res,
  HttpException,
  HttpStatus,
  Logger,
  Header,
} from '@nestjs/common';
import { Response } from 'express';
import { A2AService } from '../a2a.service';
import { GatewayResolverService } from '../services/gateway-resolver.service';
import { Gateway } from '../../../entities/gateway.entity';
import { GatewayAuthType } from '../../../entities/gateway-auth.entity';

@Controller('a2a/:orgId')
export class GatewayA2AController {
  private readonly logger = new Logger(GatewayA2AController.name);

  constructor(
    private readonly a2aService: A2AService,
    private readonly gatewayResolver: GatewayResolverService,
  ) {}

  /**
   * Build A2A-spec securitySchemes and security fields from the gateway's authConfigs.
   */
  private buildSecurityInfo(gateway: Gateway): {
    securitySchemes: Record<string, any>;
    security: Array<Record<string, any[]>>;
  } {
    const securitySchemes: Record<string, any> = {};
    const security: Array<Record<string, any[]>> = [];

    const authConfigs = gateway.authConfigs?.filter(ac => ac.isActive) || [];

    for (const authConfig of authConfigs) {
      switch (authConfig.type) {
        case GatewayAuthType.API_KEY: {
          const headerName = authConfig.configuration?.keyHeader || 'x-api-key';
          securitySchemes['apiKey'] = {
            type: 'apiKey',
            name: headerName,
            location: 'header',
            description: 'API key for gateway access',
          };
          security.push({ apiKey: [] });
          break;
        }
        case GatewayAuthType.BEARER_TOKEN: {
          securitySchemes['bearer'] = {
            type: 'http',
            scheme: 'Bearer',
            description: 'Bearer token authentication',
          };
          security.push({ bearer: [] });
          break;
        }
        case GatewayAuthType.JWT: {
          securitySchemes['bearer'] = {
            type: 'http',
            scheme: 'Bearer',
            bearerFormat: 'JWT',
            description: 'JWT Bearer token',
          };
          security.push({ bearer: [] });
          break;
        }
        case GatewayAuthType.BASIC_AUTH: {
          securitySchemes['basic'] = {
            type: 'http',
            scheme: 'Basic',
            description: 'HTTP Basic authentication',
          };
          security.push({ basic: [] });
          break;
        }
        case GatewayAuthType.OAUTH2: {
          securitySchemes['oauth2'] = {
            type: 'oauth2',
            description: 'OAuth 2.0 authentication',
            flows: authConfig.configuration?.flows || {},
          };
          security.push({ oauth2: [] });
          break;
        }
        case GatewayAuthType.NONE:
          // No security scheme needed
          break;
        default:
          break;
      }
    }

    return { securitySchemes, security };
  }

  /**
   * Build WWW-Authenticate header value for A2A 401 responses.
   */
  private buildWwwAuthenticateHeader(gateway: Gateway): string {
    const authConfigs = gateway.authConfigs?.filter(ac => ac.isActive) || [];

    const challenges: string[] = [];

    for (const authConfig of authConfigs) {
      switch (authConfig.type) {
        case GatewayAuthType.BEARER_TOKEN:
        case GatewayAuthType.JWT:
        case GatewayAuthType.OAUTH2:
          challenges.push(`Bearer realm="${gateway.name}"`);
          break;
        case GatewayAuthType.API_KEY: {
          const headerName = authConfig.configuration?.keyHeader || 'x-api-key';
          challenges.push(`ApiKey realm="${gateway.name}", header="${headerName}"`);
          break;
        }
        case GatewayAuthType.BASIC_AUTH:
          challenges.push(`Basic realm="${gateway.name}"`);
          break;
      }
    }

    // Deduplicate
    return [...new Set(challenges)].join(', ') || `Bearer realm="${gateway.name}"`;
  }

  /**
   * Handle auth failures with proper 401 + WWW-Authenticate header.
   * Resolves org + gateway first (without auth), then authenticates separately
   * so we can include the WWW-Authenticate header in 401 responses.
   */
  private async resolveAndAuthenticateWithWwwAuth(
    orgSlugOrId: string,
    gatewayEndpoint: string,
    req: any,
    res: Response,
  ) {
    try {
      return await this.gatewayResolver.resolveAndAuthenticate(orgSlugOrId, gatewayEndpoint, req);
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === HttpStatus.UNAUTHORIZED) {
        // Resolve gateway to get auth configs for WWW-Authenticate header
        try {
          const organization = await this.gatewayResolver.resolveOrganization(orgSlugOrId);
          const gateway = await this.gatewayResolver.resolveGateway(organization.id, gatewayEndpoint);
          const wwwAuth = this.buildWwwAuthenticateHeader(gateway);
          res.setHeader('WWW-Authenticate', wwwAuth);
        } catch {
          // If gateway resolution also fails, just set a generic header
          res.setHeader('WWW-Authenticate', 'Bearer');
        }

        // Also check if the resolver attached wwwAuthenticate to the exception
        if ((error as any).wwwAuthenticate) {
          res.setHeader('WWW-Authenticate', (error as any).wwwAuthenticate);
        }
      }
      throw error;
    }
  }

  @Get('*')
  @Header('Content-Type', 'application/json')
  async handleGetRequest(
    @Param('orgId') orgSlugOrId: string,
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { gatewayEndpoint, action } = this.gatewayResolver.parsePathSegments(req, orgSlugOrId, 'a2a');

    // Discovery endpoints are PUBLIC per A2A spec — clients need them to learn how to auth
    if (action === '.well-known/agent.json' || action === '.well-known/agent-card.json' || action === '.well-known/a2a') {
      const organization = await this.gatewayResolver.resolveOrganization(orgSlugOrId);
      const gateway = await this.gatewayResolver.resolveGateway(organization.id, gatewayEndpoint);

      const baseUrl = process.env.BASE_URL || 'http://localhost:4000';
      const { securitySchemes, security } = this.buildSecurityInfo(gateway);

      const agentCard: Record<string, any> = {
        protocol: 'a2a',
        version: '1.0.0',
        server: { name: 'almyty', version: '1.0.0', description: gateway.name },
        endpoints: {
          agents: `${baseUrl}/a2a/${orgSlugOrId}${gatewayEndpoint}/agents`,
          messages: `${baseUrl}/a2a/${orgSlugOrId}${gatewayEndpoint}/messages`,
          discovery: `${baseUrl}/a2a/${orgSlugOrId}${gatewayEndpoint}/.well-known/agent.json`,
        },
        gateway: { id: gateway.id, name: gateway.name },
      };

      // Include security fields so clients know how to authenticate
      if (Object.keys(securitySchemes).length > 0) {
        agentCard.securitySchemes = securitySchemes;
        agentCard.security = security;
      }

      return agentCard;
    }

    // All other endpoints require auth
    const { organization, gateway } = await this.resolveAndAuthenticateWithWwwAuth(orgSlugOrId, gatewayEndpoint, req, res);

    this.logger.log(`A2A gateway request: org=${orgSlugOrId}, gateway=${gateway.name}, action=${action}`);

    if (action === 'agents') {
      return this.a2aService.listAgents(organization.id);
    }

    throw new HttpException(`Unknown A2A action: ${action}`, HttpStatus.NOT_FOUND);
  }

  @Post('*')
  @Header('Content-Type', 'application/json')
  async handlePostRequest(
    @Param('orgId') orgSlugOrId: string,
    @Body() body: any,
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { gatewayEndpoint, action } = this.gatewayResolver.parsePathSegments(req, orgSlugOrId, 'a2a');
    const { organization, gateway } = await this.resolveAndAuthenticateWithWwwAuth(orgSlugOrId, gatewayEndpoint, req, res);

    this.logger.log(`A2A gateway POST: org=${orgSlugOrId}, gateway=${gateway.name}, action=${action}`);

    if (action === 'messages' && body.fromAgentId && body.toAgentId) {
      return this.a2aService.sendMessage(body.fromAgentId, body.toAgentId, body.content, body.messageType);
    }

    if (action === 'agents' && body.name) {
      return this.a2aService.registerAgent(organization.id, body);
    }

    throw new HttpException(`Unknown A2A action: ${action}`, HttpStatus.NOT_FOUND);
  }
}
