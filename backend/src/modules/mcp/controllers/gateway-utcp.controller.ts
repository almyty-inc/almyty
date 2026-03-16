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
import { UtcpService } from '../utcp.service';
import { GatewayResolverService } from '../services/gateway-resolver.service';
import { Gateway } from '../../../entities/gateway.entity';
import { GatewayAuthType } from '../../../entities/gateway-auth.entity';

@Controller('utcp/:orgId')
export class GatewayUtcpController {
  private readonly logger = new Logger(GatewayUtcpController.name);

  constructor(
    private readonly utcpService: UtcpService,
    private readonly gatewayResolver: GatewayResolverService,
  ) {}

  /**
   * Build UTCP-spec auth object from the gateway's authConfigs.
   * Returns an array of auth descriptors per the UTCP spec.
   */
  private buildUtcpAuth(gateway: Gateway): any[] {
    const authConfigs = gateway.authConfigs?.filter(ac => ac.isActive) || [];
    const authObjects: any[] = [];

    for (const authConfig of authConfigs) {
      switch (authConfig.type) {
        case GatewayAuthType.API_KEY: {
          const headerName = authConfig.configuration?.keyHeader || 'x-api-key';
          authObjects.push({
            auth_type: 'api_key',
            var_name: headerName,
            location: 'header',
          });
          break;
        }
        case GatewayAuthType.BEARER_TOKEN: {
          authObjects.push({
            auth_type: 'bearer',
            var_name: 'Authorization',
            location: 'header',
          });
          break;
        }
        case GatewayAuthType.JWT: {
          authObjects.push({
            auth_type: 'bearer',
            var_name: 'Authorization',
            location: 'header',
            format: 'JWT',
          });
          break;
        }
        case GatewayAuthType.BASIC_AUTH: {
          authObjects.push({
            auth_type: 'basic',
            var_name: 'Authorization',
            location: 'header',
          });
          break;
        }
        case GatewayAuthType.OAUTH2: {
          authObjects.push({
            auth_type: 'oauth2',
            var_name: 'Authorization',
            location: 'header',
          });
          break;
        }
        case GatewayAuthType.NONE:
          // No auth descriptor needed
          break;
        default:
          break;
      }
    }

    return authObjects;
  }

  /**
   * Build WWW-Authenticate header value for UTCP 401 responses.
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

    return [...new Set(challenges)].join(', ') || `Bearer realm="${gateway.name}"`;
  }

  /**
   * Handle auth failures with proper 401 + WWW-Authenticate header.
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
        try {
          const organization = await this.gatewayResolver.resolveOrganization(orgSlugOrId);
          const gateway = await this.gatewayResolver.resolveGateway(organization.id, gatewayEndpoint);
          const wwwAuth = this.buildWwwAuthenticateHeader(gateway);
          res.setHeader('WWW-Authenticate', wwwAuth);
        } catch {
          res.setHeader('WWW-Authenticate', 'Bearer');
        }

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
    const { gatewayEndpoint, action } = this.gatewayResolver.parsePathSegments(req, orgSlugOrId, 'utcp');

    // Discovery endpoints are PUBLIC per UTCP spec — clients need them to learn how to auth
    if (action === '.well-known/utcp' || action === 'manual') {
      const organization = await this.gatewayResolver.resolveOrganization(orgSlugOrId);
      const gateway = await this.gatewayResolver.resolveGateway(organization.id, gatewayEndpoint);

      this.logger.log(`UTCP discovery: org=${orgSlugOrId}, gateway=${gateway.name}, action=${action}`);

      if (action === '.well-known/utcp') {
        const discoveryInfo = this.utcpService.getDiscoveryInfo(organization.id);
        const authObjects = this.buildUtcpAuth(gateway);

        if (authObjects.length > 0) {
          return {
            ...discoveryInfo,
            auth: authObjects.length === 1 ? authObjects[0] : authObjects,
          };
        }
        return discoveryInfo;
      }

      // manual
      const manual = await this.utcpService.generateManual(organization.id);
      const authObjects = this.buildUtcpAuth(gateway);

      if (authObjects.length > 0) {
        return {
          ...manual,
          auth: authObjects.length === 1 ? authObjects[0] : authObjects,
        };
      }
      return manual;
    }

    // All other endpoints require auth
    const { organization, gateway } = await this.resolveAndAuthenticateWithWwwAuth(orgSlugOrId, gatewayEndpoint, req, res);

    this.logger.log(`UTCP gateway request: org=${orgSlugOrId}, gateway=${gateway.name}, action=${action}`);

    throw new HttpException(`Unknown UTCP action: ${action}`, HttpStatus.NOT_FOUND);
  }

  @Post('*')
  @Header('Content-Type', 'application/json')
  async handlePostRequest(
    @Param('orgId') orgSlugOrId: string,
    @Body() body: any,
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { gatewayEndpoint, action } = this.gatewayResolver.parsePathSegments(req, orgSlugOrId, 'utcp');
    const { organization, gateway } = await this.resolveAndAuthenticateWithWwwAuth(orgSlugOrId, gatewayEndpoint, req, res);

    this.logger.log(`UTCP gateway POST: org=${orgSlugOrId}, gateway=${gateway.name}, action=${action}`);

    if (action === 'execute') {
      return this.utcpService.executeUtcpTool(body, organization.id);
    }

    throw new HttpException(`Unknown UTCP action: ${action}`, HttpStatus.NOT_FOUND);
  }
}
