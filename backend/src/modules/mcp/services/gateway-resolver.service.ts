import { Injectable, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Gateway, GatewayStatus } from '../../../entities/gateway.entity';
import { GatewayAuth, GatewayAuthType } from '../../../entities/gateway-auth.entity';
import { Organization } from '../../../entities/organization.entity';
import { GatewayAuthService, AuthenticationResult } from '../../gateways/gateway-auth.service';
import { gatewayServableTo, isPrivateGateway } from '../../gateways/private-gateway';

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
   * The system gateway (almyty) is a real DB row, so no special-casing needed.
   */
  async resolveGateway(organizationId: string, endpoint: string): Promise<Gateway> {
    const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    const gateway = await this.gatewayRepository.findOne({
      where: {
        endpoint: normalizedEndpoint,
        organizationId,
        status: GatewayStatus.ACTIVE,
      },
      relations: { organization: true, authConfigs: true },
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
    const active = gateway.authConfigs?.filter((a) => a.isActive) || [];
    const types = new Set(active.map((a) => a.type));
    const baseUrl = process.env.BASE_URL || process.env.API_URL || 'http://localhost:4000';
    const gatewaySlug = gateway.endpoint?.replace(/^\//, '') || '';

    // RFC 7235: a 401 may carry multiple challenges. Emit one per
    // active scheme so clients can pick what they support; previously
    // a BASIC-only gateway sent `Bearer realm=...`, which RFC 7617
    // forbids and which makes browsers skip the credential prompt.
    const challenges: string[] = [];

    if (types.has(GatewayAuthType.OAUTH2)) {
      const resourceMetadataUrl = `${baseUrl}/${orgSlug}/${gatewaySlug}/.well-known/oauth-protected-resource`;
      challenges.push(`Bearer resource_metadata="${resourceMetadataUrl}"`);
    }
    if (types.has(GatewayAuthType.BEARER_TOKEN) || types.has(GatewayAuthType.JWT)) {
      challenges.push(`Bearer realm="${gateway.name}"`);
    }
    if (types.has(GatewayAuthType.API_KEY)) {
      const cfg = active.find((a) => a.type === GatewayAuthType.API_KEY)?.configuration;
      const header = cfg?.keyHeader || 'x-api-key';
      challenges.push(`ApiKey realm="${gateway.name}", header="${header}"`);
    }
    if (types.has(GatewayAuthType.BASIC_AUTH)) {
      challenges.push(`Basic realm="${gateway.name}"`);
    }

    // Dedupe, preserve insertion order
    const seen = new Set<string>();
    const dedup = challenges.filter((c) => (seen.has(c) ? false : (seen.add(c), true)));
    if (dedup.length === 0) return `Bearer realm="${gateway.name}"`;
    return dedup.join(', ');
  }

  /**
   * The gateway's active auth configs, already in hand.
   *
   * Both paths into this service load `authConfigs` as a relation, so
   * GatewayAuthService does not have to query for them a second time.
   * The relation arrives without its inverse `gateway` side, which
   * `validateOAuth2` reads to bind the token to the owning org — that is
   * backfilled onto a copy rather than mutated onto the caller's entity,
   * which would make the object graph circular. Returns undefined when
   * the relation was never loaded, so the auth service falls back to its
   * own query and nothing changes for callers that pass a bare gateway.
   */
  private activeAuthConfigs(gateway: Gateway): GatewayAuth[] | undefined {
    if (!Array.isArray(gateway.authConfigs)) return undefined;

    return gateway.authConfigs
      .filter((config) => config.isActive)
      .map((config) =>
        config.gateway
          ? config
          : (Object.assign(
              Object.create(Object.getPrototypeOf(config) ?? Object.prototype),
              config,
              { gateway },
            ) as GatewayAuth),
      )
      .sort((a, b) => {
        const left = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const right = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return left - right;
      });
  }

  /**
   * For a private gateway: the auth result when the request authenticates
   * through the gateway's own auth configs AS ITS OWNER, else null.
   *
   * Never throws for an auth failure -- the caller turns null into the
   * not-found answer. A gateway with no auth configs, or one whose accepted
   * credential names no user (custom tokens, OAuth tokens without a
   * subject), serves nobody: there is no way to know the caller is the
   * owner, and "just me" fails closed.
   */
  async authenticatePrivateOwner(gateway: Gateway, req: any): Promise<AuthenticationResult | null> {
    if (!isPrivateGateway(gateway)) return null;
    let auth: AuthenticationResult;
    try {
      auth = await this.gatewayAuthService.authenticateRequest(
        gateway.id,
        req?.headers || {},
        req?.query || {},
        req?.body,
        req?.ip || req?.connection?.remoteAddress,
        this.activeAuthConfigs(gateway),
      );
    } catch {
      return null;
    }
    if (!auth?.isValid || !gatewayServableTo(gateway, auth.userId)) return null;
    return auth;
  }

  /**
   * Full resolution pipeline: org → gateway → auth check.
   * Returns the resolved org, gateway, and auth result.
   * Throws HttpException on any failure.
   *
   * `preResolved` is for callers that already hold both — the unified
   * endpoint resolves the org and loads the gateway before it delegates,
   * and re-running those two lookups here was two redundant queries on
   * the hottest route in the product. Omit it and resolution is exactly
   * as it was.
   */
  async resolveAndAuthenticate(
    orgSlugOrId: string,
    gatewayEndpoint: string,
    req: any,
    preResolved?: { organization: Organization; gateway: Gateway },
  ): Promise<ResolvedGateway> {
    const organization =
      preResolved?.organization ?? (await this.resolveOrganization(orgSlugOrId));
    const gateway =
      preResolved?.gateway ?? (await this.resolveGateway(organization.id, gatewayEndpoint));

    // A private gateway answers its owner and nobody else. Anyone else --
    // anonymous, a key or token of another member, an admin -- gets the
    // answer a gateway that does not exist gets: the same 404, and no
    // WWW-Authenticate challenge that would confirm there is something
    // here to authenticate against.
    if (isPrivateGateway(gateway)) {
      const ownerAuth = await this.authenticatePrivateOwner(gateway, req);
      if (!ownerAuth) {
        throw new HttpException(`Gateway not found: ${gatewayEndpoint}`, HttpStatus.NOT_FOUND);
      }
      return { organization, gateway, auth: ownerAuth };
    }

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
      this.activeAuthConfigs(gateway),
    );
    if (!auth.isValid) {
      const statusCode = auth.errorCode?.includes('MISSING') ? HttpStatus.UNAUTHORIZED : HttpStatus.FORBIDDEN;

      // MCP spec: include WWW-Authenticate header with resource_metadata URL on 401
      const wwwAuthenticate = this.buildWwwAuthenticateHeader(gateway, orgSlugOrId);

      const reason = auth.error || 'Authentication failed';
      const errorCode = auth.errorCode || 'AUTH_FAILED';

      // `message` is not decoration. HttpException derives its own
      // `message` from the payload and falls back to the class name when
      // the payload has no `message` key — so this payload used to make
      // `exception.message === 'Http Exception'`, which is the string the
      // client was shown and the string written to
      // `request_logs.errorMessage` for every refused gateway request.
      // The filter also strips `error` from the forwarded details, so
      // without this the human-readable reason existed nowhere.
      const error: any = {
        message: reason,
        error: reason,
        errorCode,
      };

      const exception = new HttpException(error, statusCode);

      // Attach WWW-Authenticate header info for the controller to pick up
      if (wwwAuthenticate && statusCode === HttpStatus.UNAUTHORIZED) {
        (exception as any).wwwAuthenticate = wwwAuthenticate;
      }

      // Diagnostics for the request log, deliberately NOT on the payload:
      // which auth config refused is an answer for us, not something to
      // hand an unauthenticated caller.
      (exception as any).errorCode = errorCode;
      (exception as any).authDiagnostics = {
        authConfigId: auth.authConfigId ?? null,
        authConfigType: auth.authConfigType ?? null,
        triedConfigCount: auth.triedConfigCount ?? null,
        gatewayId: gateway.id,
      };

      this.logger.warn(
        `Gateway auth refused: org=${orgSlugOrId} gateway=${gateway.name} ` +
          `code=${errorCode} authConfig=${auth.authConfigId ?? 'none'} status=${statusCode}`,
      );

      throw exception;
    }

    this.logger.log(`Gateway resolved: org=${orgSlugOrId}, gateway=${gateway.name}, auth=${auth.isValid}`);

    return { organization, gateway, auth };
  }
}
