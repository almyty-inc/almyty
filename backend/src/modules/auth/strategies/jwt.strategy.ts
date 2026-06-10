import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Request } from 'express';
import { User } from '../../../entities/user.entity';
import { JwtPayload } from '../auth.service';

/**
 * Extract JWT from httpOnly cookie first, then fall back to Authorization header.
 * This keeps backward compatibility with Bearer token auth for programmatic clients
 * while allowing the web UI to use secure httpOnly cookies.
 */
function extractJwtFromCookieOrHeader(req: Request): string | null {
  // 1. Try httpOnly cookie
  if (req.cookies?.access_token) {
    return req.cookies.access_token;
  }
  // 2. Fall back to Authorization: Bearer <token> header
  const extractor = ExtractJwt.fromAuthHeaderAsBearerToken();
  return extractor(req);
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    @InjectRepository(User)
    private userRepository: Repository<User>,
  ) {
    super({
      jwtFromRequest: extractJwtFromCookieOrHeader,
      ignoreExpiration: false,
      secretOrKey:
        configService.get<string>('JWT_SECRET') ||
        'dev-only-jwt-secret-change-me-in-production',
      // Enforce the iss + aud claims set by JwtModule.signOptions
      // (see auth.module.ts). passport-jwt configures these as
      // strings, not verifyOptions — if they're missing or wrong,
      // verification fails with "jwt issuer invalid" / "jwt
      // audience invalid" and the request is 401'd. Prevents
      // cross-service token replay if JWT_SECRET is ever shared.
      issuer: 'almyty',
      audience: 'almyty-api',
      passReqToCallback: true,
    });
  }

  async validate(req: Request, payload: JwtPayload): Promise<User> {
    // Only load organizationMemberships, skip apiKeys for performance
    const user = await this.userRepository.findOne({
      where: { id: payload.sub },
      relations: [
        'organizationMemberships',
        'organizationMemberships.organization',
      ],
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('User not found or inactive');
    }

    // Reject access tokens minted before a tokenVersion bump (password
    // change/reset revokes all outstanding sessions). A missing claim is
    // treated as 0 so tokens issued before this field existed stay valid
    // until the user's first bump.
    if (((payload as any).tv ?? 0) !== (user.tokenVersion ?? 0)) {
      throw new UnauthorizedException('Token has been revoked');
    }

    // Attach the user's org list.
    (user as any).organizations = user.organizationMemberships?.map(membership => ({
      id: membership.organizationId || membership.organization?.id,
      name: membership.organization?.name,
      role: membership.role,
    })) || [];

    // Resolve the ACTIVE organization for this request. Multi-org users
    // must explicitly scope every request via `X-Organization-Id`.
    // Previously we always set this to memberships[0], which meant:
    //   - Multi-org users could only ever reach their FIRST org, because
    //     handlers blindly read `currentOrganizationId` and used it to
    //     build their queries.
    //   - The RolesGuard's "require explicit context for multi-org users"
    //     safety was defeated because `currentOrganizationId` was always
    //     set and took precedence over the single-org fallback.
    //
    // New behaviour:
    //   - X-Organization-Id header: must match a membership — use it.
    //     Reject with 401 if set but not a member.
    //   - No header + exactly one org: use that org (common case).
    //   - No header + multiple orgs: leave `currentOrganizationId`
    //     undefined. The RolesGuard / handlers must then refuse the
    //     request with a clear "Organization context required" error.
    const headerOrgId = (req.headers?.['x-organization-id'] as string) || undefined;
    if (headerOrgId) {
      const isMember = user.organizationMemberships?.some(
        (m) => (m.organizationId || m.organization?.id) === headerOrgId,
      );
      if (!isMember) {
        throw new UnauthorizedException('Not a member of the requested organization');
      }
      (user as any).currentOrganizationId = headerOrgId;
    } else if (user.organizationMemberships?.length === 1) {
      (user as any).currentOrganizationId = user.organizationMemberships[0].organizationId;
    } else {
      (user as any).currentOrganizationId = undefined;
    }

    return user;
  }
}