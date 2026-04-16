import { Controller, Get, Param, Header, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Gateway, GatewayStatus } from '../../../entities/gateway.entity';
import { Organization } from '../../../entities/organization.entity';
import { getBaseUrl } from '../../../common/config/base-url';

/**
 * Root-level OAuth discovery routes per RFC 8414 Section 3 and RFC 9728.
 *
 * RFC 8414 specifies that authorization server metadata lives at:
 *   {scheme}://{authority}/.well-known/oauth-authorization-server{path}
 *
 * So for server URL https://api.almyty.com/org/gateway, the metadata is at:
 *   https://api.almyty.com/.well-known/oauth-authorization-server/org/gateway
 *
 * MCP clients (Claude Code, Claude Desktop) follow this convention.
 */
@Controller('.well-known')
export class McpOAuthDiscoveryController {
  private readonly logger = new Logger(McpOAuthDiscoveryController.name);

  constructor(
    @InjectRepository(Gateway)
    private readonly gatewayRepository: Repository<Gateway>,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    private readonly configService: ConfigService,
  ) {}

  @Get('oauth-authorization-server/:orgSlug/:gatewaySlug')
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Header('Content-Type', 'application/json')
  async authServerMetadata(
    @Param('orgSlug') orgSlug: string,
    @Param('gatewaySlug') gatewaySlug: string,
  ) {
    await this.resolveOrgAndGateway(orgSlug, gatewaySlug);
    const base = getBaseUrl(this.configService);
    const prefix = `${base}/${orgSlug}/${gatewaySlug}`;

    return {
      issuer: prefix,
      authorization_endpoint: `${prefix}/authorize`,
      token_endpoint: `${prefix}/token`,
      registration_endpoint: `${prefix}/register`,
      revocation_endpoint: `${prefix}/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['mcp:tools', 'mcp:resources', 'mcp:prompts', 'mcp:*'],
      service_documentation: `${base}/docs`,
    };
  }

  @Get('oauth-protected-resource/:orgSlug/:gatewaySlug')
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Header('Content-Type', 'application/json')
  async protectedResourceMetadata(
    @Param('orgSlug') orgSlug: string,
    @Param('gatewaySlug') gatewaySlug: string,
  ) {
    await this.resolveOrgAndGateway(orgSlug, gatewaySlug);
    const base = getBaseUrl(this.configService);
    const prefix = `${base}/${orgSlug}/${gatewaySlug}`;

    return {
      resource: prefix,
      authorization_servers: [prefix],
      scopes_supported: ['mcp:tools', 'mcp:resources', 'mcp:prompts', 'mcp:*'],
      bearer_methods_supported: ['header'],
      resource_name: gatewaySlug,
      resource_documentation: `${base}/docs`,
    };
  }

  private async resolveOrgAndGateway(orgSlug: string, gatewaySlug: string): Promise<void> {
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgSlug);
    const org = await this.organizationRepository.findOne({
      where: isUUID ? [{ slug: orgSlug }, { id: orgSlug }] : { slug: orgSlug },
    });
    if (!org) {
      throw new HttpException('Organization not found', HttpStatus.NOT_FOUND);
    }

    const endpoint = gatewaySlug.startsWith('/') ? gatewaySlug : `/${gatewaySlug}`;
    const gateway = await this.gatewayRepository.findOne({
      where: { endpoint, organizationId: org.id, status: GatewayStatus.ACTIVE },
    });
    if (!gateway) {
      throw new HttpException('Gateway not found', HttpStatus.NOT_FOUND);
    }
  }
}
