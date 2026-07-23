import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Gateway, GatewayStatus } from '../../../entities/gateway.entity';
import { Organization } from '../../../entities/organization.entity';
import { getBaseUrl, getFrontendUrl } from '../../../common/config/base-url';

/**
 * Resolution helpers extracted from McpOAuthController:
 * URL-slug to org/gateway lookups, JWT cookie extraction, and the
 * base/frontend URL accessors.
 *
 * Lives in its own class so the controller can stay focused on
 * the OAuth flow shapes.
 */
@Injectable()
export class McpOAuthResolveHelper {
  constructor(
    @InjectRepository(Gateway)
    private readonly gatewayRepository: Repository<Gateway>,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * Try to extract and verify the user from the JWT cookie or
   * Authorization header. Returns the JWT payload if valid, null
   * otherwise. Never throws.
   */
  async tryExtractUser(req: any): Promise<any | null> {
    if (req.user) return req.user;
    const token =
      req.cookies?.access_token ||
      (req.headers?.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : null);
    if (!token) return null;
    try {
      return this.jwtService.verify(token);
    } catch {
      return null;
    }
  }

  /**
   * Resolve organization by slug or UUID, without requiring authentication.
   * Mirrors GatewayResolverService.resolveOrganization but lives here to
   * avoid pulling in the auth pipeline.
   */
  async resolveOrg(orgSlug: string): Promise<Organization> {
    const isUUID =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgSlug);

    if (isUUID) {
      const org = await this.organizationRepository.findOne({
        where: { id: orgSlug },
      });
      if (!org) {
        throw new HttpException(`Organization not found: ${orgSlug}`, HttpStatus.NOT_FOUND);
      }
      return org;
    }

    // One targeted query that computes the slug-from-name comparison
    // in SQL — previously a missed slug fell back to a full scan of
    // the orgs table, a DoS vector on a public endpoint.
    const org = await this.organizationRepository
      .createQueryBuilder('org')
      .where('org.slug = :slug', { slug: orgSlug })
      .orWhere("LOWER(REPLACE(org.name, ' ', '-')) = :slug", { slug: orgSlug })
      .limit(1)
      .getOne();

    if (!org) {
      throw new HttpException(`Organization not found: ${orgSlug}`, HttpStatus.NOT_FOUND);
    }
    return org;
  }

  /**
   * Resolve an active gateway by its endpoint slug within an organization.
   * `gatewaySlug` is matched against `endpoint` (e.g. "my-gateway" maps to
   * endpoint "/my-gateway").
   */
  async resolveGateway(organizationId: string, gatewaySlug: string): Promise<Gateway> {
    const endpoint = gatewaySlug.startsWith('/') ? gatewaySlug : `/${gatewaySlug}`;

    const gateway = await this.gatewayRepository.findOne({
      where: { endpoint, organizationId, status: GatewayStatus.ACTIVE },
      relations: { organization: true },
    });

    if (!gateway) {
      throw new HttpException(`Gateway not found: ${gatewaySlug}`, HttpStatus.NOT_FOUND);
    }
    return gateway;
  }

  /** Resolve both org and gateway from URL slugs in one call. */
  async resolveOrgAndGateway(
    orgSlug: string,
    gatewaySlug: string,
  ): Promise<{ organization: Organization; gateway: Gateway }> {
    const organization = await this.resolveOrg(orgSlug);
    const gateway = await this.resolveGateway(organization.id, gatewaySlug);
    return { organization, gateway };
  }

  getBaseUrl(): string {
    return getBaseUrl(this.configService);
  }

  getFrontendUrl(): string {
    return getFrontendUrl(this.configService);
  }
}
