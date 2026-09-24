import { ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Gateway, GatewayStatus } from '../../../entities/gateway.entity';
import { Organization } from '../../../entities/organization.entity';
import { gatewayServableTo } from '../../gateways/private-gateway';
import { getBaseUrl, getFrontendUrl } from '../../../common/config/base-url';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';

/**
 * Resolution helpers extracted from McpOAuthController:
 * URL-slug to org/gateway lookups, session extraction, and the
 * base/frontend URL accessors.
 *
 * Lives in its own class so the controller can stay focused on
 * the OAuth flow shapes.
 */
@Injectable()
export class McpOAuthResolveHelper {
  /**
   * The guard every dashboard route uses, run by hand so a missing or
   * refused session can become a login redirect instead of a 401.
   */
  private readonly sessionGuard = new JwtAuthGuard(new Reflector());

  constructor(
    @InjectRepository(Gateway)
    private readonly gatewayRepository: Repository<Gateway>,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    private readonly configService: ConfigService,
  ) {}

  /**
   * The signed-in user, validated exactly as JwtAuthGuard validates one,
   * or null. Never throws.
   *
   * This used to `jwtService.verify` the cookie and hand back the raw
   * payload. That skipped everything JwtStrategy checks after the
   * signature: the account being active, the tokenVersion a password
   * change bumps, the SSO confinement to one organization, and current
   * membership -- the `organizations` claim it returned was whatever the
   * token said when it was minted, so a removed member still passed the
   * authorize step's membership check.
   */
  async tryExtractUser(req: any, res: any = {}): Promise<any | null> {
    if (req.user) return req.user;
    const context = {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res, getNext: () => undefined }),
      getHandler: () => this.tryExtractUser,
      getClass: () => McpOAuthResolveHelper,
      getType: () => 'http',
      getArgs: () => [req, res],
      getArgByIndex: (i: number) => [req, res][i],
    } as unknown as ExecutionContext;
    try {
      const allowed = await this.sessionGuard.canActivate(context);
      return allowed ? req.user ?? null : null;
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
   *
   * `viewerId` is who is asking, when the step is one a person takes
   * (discovery, consent, authorize, client registration). Another user's
   * private gateway -- or any private gateway, for an anonymous step --
   * answers exactly like a slug that does not exist. Omit it only on the
   * steps whose credential is already bound to a user and a gateway (the
   * token exchange and revocation): a code or token for a private gateway
   * can only have been issued to its owner.
   */
  async resolveGateway(
    organizationId: string,
    gatewaySlug: string,
    viewerId?: string | null,
  ): Promise<Gateway> {
    const endpoint = gatewaySlug.startsWith('/') ? gatewaySlug : `/${gatewaySlug}`;

    const gateway = await this.gatewayRepository.findOne({
      where: { endpoint, organizationId, status: GatewayStatus.ACTIVE },
      relations: { organization: true },
    });

    if (!gateway || (viewerId !== undefined && !gatewayServableTo(gateway, viewerId))) {
      throw new HttpException(`Gateway not found: ${gatewaySlug}`, HttpStatus.NOT_FOUND);
    }
    return gateway;
  }

  /** Resolve both org and gateway from URL slugs in one call. */
  async resolveOrgAndGateway(
    orgSlug: string,
    gatewaySlug: string,
    viewerId?: string | null,
  ): Promise<{ organization: Organization; gateway: Gateway }> {
    const organization = await this.resolveOrg(orgSlug);
    const gateway = await this.resolveGateway(organization.id, gatewaySlug, viewerId);
    return { organization, gateway };
  }

  /** The user id of a JWT payload or request user, or null. */
  static userIdOf(user: any): string | null {
    return user?.sub || user?.id || null;
  }
  getBaseUrl(): string {
    return getBaseUrl(this.configService);
  }

  getFrontendUrl(): string {
    return getFrontendUrl(this.configService);
  }
}
