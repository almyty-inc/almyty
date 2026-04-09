import { Injectable, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Gateway, GatewayStatus } from '../../../entities/gateway.entity';
import { GatewayAuthType } from '../../../entities/gateway-auth.entity';
import { Organization } from '../../../entities/organization.entity';
import { GatewayAuthService, AuthenticationResult } from '../../gateways/gateway-auth.service';

export interface ResolvedGateway {
  organization: Organization;
  gateway: Gateway;
  auth: AuthenticationResult;
}

@Injectable()
export class GatewayResolverService {
  private readonly logger = new Logger(GatewayResolverService.name);

  constructor(
    @InjectRepository(Gateway)
    private gatewayRepository: Repository<Gateway>,
    @InjectRepository(Organization)
    private organizationRepository: Repository<Organization>,
    private gatewayAuthService: GatewayAuthService,
  ) {}

  /**
   * Resolve organization from slug, name-based slug, or UUID.
   * Single source of truth — used by all gateway controllers.
   */
  async resolveOrganization(orgSlugOrId: string): Promise<Organization> {
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgSlugOrId);

    if (isUUID) {
      const org = await this.organizationRepository.findOne({
        where: { id: orgSlugOrId },
      });
      if (!org) {
        throw new HttpException(`Organization not found: ${orgSlugOrId}`, HttpStatus.NOT_FOUND);
      }
      return org;
    }

    // Try exact slug match first
    let org = await this.organizationRepository.findOne({
      where: { slug: orgSlugOrId },
    });

    // Fallback: name-based slug (for orgs created before the slug
    // field was required). Previously this loaded every
    // organization row into memory and iterated in JS — a DoS
    // vector on a large deployment. Narrow to a single LOWER()
    // + REPLACE match in SQL so the query runs in O(log n)
    // instead of O(n).
    if (!org) {
      org = await this.organizationRepository
        .createQueryBuilder('org')
        .where(
          `REPLACE(LOWER(org.name), ' ', '-') = :slug`,
          { slug: orgSlugOrId.toLowerCase() },
        )
        .getOne();
    }

    if (!org) {
      throw new HttpException(`Organization not found: ${orgSlugOrId}`, HttpStatus.NOT_FOUND);
    }
    return org;
  }

  /**
   * Find an active gateway by endpoint path within an organization.
   */
  async resolveGateway(organizationId: string, endpoint: string): Promise<Gateway> {
    const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    const gateway = await this.gatewayRepository.findOne({
      where: {
        endpoint: normalizedEndpoint,
        organizationId,
        status: GatewayStatus.ACTIVE,
      },
      relations: ['organization', 'authConfigs'],
    });

    if (!gateway) {
      throw new HttpException(`Gateway not found: ${endpoint}`, HttpStatus.NOT_FOUND);
    }
    return gateway;
  }

  /**
   * Parse protocol path segments: /{protocol}/{orgSlug}/{gatewayEndpoint}/{action}
   * Returns the gateway endpoint and action from the URL path.
   */
  parsePathSegments(req: any, orgSlugOrId: string, protocol: string): { gatewayEndpoint: string; action: string } {
    const fullPath = req.path;
    const afterOrg = fullPath.replace(`/${protocol}/${orgSlugOrId}`, '');
    const segments = afterOrg.split('/').filter(Boolean);

    if (segments.length < 2) {
      throw new HttpException(
        `Invalid ${protocol.toUpperCase()} path. Expected: /${protocol}/{org}/{gateway}/{action}`,
        HttpStatus.BAD_REQUEST,
      );
    }

    return {
      gatewayEndpoint: `/${segments[0]}`,
      action: segments.slice(1).join('/'),
    };
  }

  /**
   * Build WWW-Authenticate header per MCP spec (RFC 9728).
   * Tells MCP clients where to discover OAuth authorization server.
   */
  private buildWwwAuthenticateHeader(gateway: Gateway, orgSlug: string): string | null {
    const hasOAuthAuth = gateway.authConfigs?.some(
      (ac) => ac.type === GatewayAuthType.OAUTH2,
    );
    const hasApiKeyAuth = gateway.authConfigs?.some(
      (ac) => ac.type === GatewayAuthType.API_KEY,
    );

    const baseUrl = process.env.BASE_URL || process.env.API_URL || 'https://api.staging.almyty.com';
    const gatewaySlug = gateway.endpoint?.replace(/^\//, '') || '';

    if (hasOAuthAuth) {
      const resourceMetadataUrl = `${baseUrl}/mcp/${orgSlug}/${gatewaySlug}/.well-known/oauth-protected-resource`;
      return `Bearer resource_metadata="${resourceMetadataUrl}"`;
    }

    if (hasApiKeyAuth) {
      return `ApiKey realm="${gateway.name}", header="x-api-key"`;
    }

    return `Bearer realm="${gateway.name}"`;
  }

  /**
   * Full resolution pipeline: org → gateway → auth check.
   * Returns the resolved org, gateway, and auth result.
   * Throws HttpException on any failure.
   */
  async resolveAndAuthenticate(
    orgSlugOrId: string,
    gatewayEndpoint: string,
    req: any,
  ): Promise<ResolvedGateway> {
    const organization = await this.resolveOrganization(orgSlugOrId);
    const gateway = await this.resolveGateway(organization.id, gatewayEndpoint);

    // Enforce gateway auth
    const headers = req.headers || {};
    const query = req.query || {};
    const clientIp = req.ip || req.connection?.remoteAddress;

    const auth = await this.gatewayAuthService.authenticateRequest(
      gateway.id,
      headers,
      query,
      req.body,
      clientIp,
    );

    if (!auth.isValid) {
      const statusCode = auth.errorCode?.includes('MISSING') ? HttpStatus.UNAUTHORIZED : HttpStatus.FORBIDDEN;

      // MCP spec: include WWW-Authenticate header with resource_metadata URL on 401
      const wwwAuthenticate = this.buildWwwAuthenticateHeader(gateway, orgSlugOrId);

      const error: any = {
        error: auth.error || 'Authentication failed',
        errorCode: auth.errorCode || 'AUTH_FAILED',
      };

      const exception = new HttpException(error, statusCode);

      // Attach WWW-Authenticate header info for the controller to pick up
      if (wwwAuthenticate && statusCode === HttpStatus.UNAUTHORIZED) {
        (exception as any).wwwAuthenticate = wwwAuthenticate;
      }

      throw exception;
    }

    this.logger.log(`Gateway resolved: org=${orgSlugOrId}, gateway=${gateway.name}, auth=${auth.isValid}`);

    return { organization, gateway, auth };
  }
}
