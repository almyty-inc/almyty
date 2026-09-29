import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Request } from 'express';
import { User } from '../../../entities/user.entity';
import { JwtPayload } from '../auth.service';
import {
  effectiveMemberships,
  hasEffectiveMembership,
  membershipOrgId,
} from '../../../common/authorization/membership';
import { jwtSecretOrDevFallback } from '../dev-jwt-secret';
import { AuthSession } from '../../../entities/auth-session.entity';
import { isSessionLive } from '../auth-session.service';
import { ACCESS_TOKEN_AUDIENCE, JWT_ALGORITHM, JWT_ISSUER, isAccessTokenPayload } from '../token-kinds';

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
    @InjectRepository(AuthSession)
    private sessionRepository: Repository<AuthSession>,
  ) {
    super({
      jwtFromRequest: extractJwtFromCookieOrHeader,
      ignoreExpiration: false,
      secretOrKey: jwtSecretOrDevFallback(configService.get<string>('JWT_SECRET'), 'JwtStrategy'),
      // HS256 only, the one algorithm tokens are signed with.
      algorithms: [JWT_ALGORITHM],
      // Enforce the iss + aud claims set by JwtModule.signOptions
      // (see auth.module.ts). passport-jwt configures these as
      // strings, not verifyOptions — if they're missing or wrong,
      // verification fails with "jwt issuer invalid" / "jwt
      // audience invalid" and the request is 401'd. The audience is
      // also what keeps refresh and email-verification tokens, signed
      // with the same secret, from verifying here (see token-kinds.ts).
      issuer: JWT_ISSUER,
      audience: ACCESS_TOKEN_AUDIENCE,
      passReqToCallback: true,
    });
  }

  async validate(req: Request, payload: JwtPayload): Promise<User> {
    if (!isAccessTokenPayload(payload)) {
      throw new UnauthorizedException('Not an access token');
    }

    // Only load organizationMemberships, skip apiKeys for performance
    const user = await this.userRepository.findOne({
      where: { id: payload.sub },
      relations: {
        organizationMemberships: { organization: true },
      },
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

    // The session the token belongs to must still be live: logout and a
    // replayed refresh token revoke it (see AuthSession). Every token
    // AuthService signs names one; a token without `sid` could only have
    // been signed outside it (spec fixtures), and is held to `tv` alone.
    if (payload.sid !== undefined) {
      if (!(await isSessionLive(this.sessionRepository, payload.sid, user.id))) {
        throw new UnauthorizedException('Session has ended');
      }
      (user as any).sessionId = payload.sid;
    }

    // An SSO session reaches the organization whose IdP asserted it and
    // no other (see sso-session.ts). Narrowing the loaded rows here means
    // the header check below, RolesGuard and every handler that reads
    // `organizationMemberships` see the one organization.
    if (payload.sso) {
      user.organizationMemberships = (user.organizationMemberships ?? []).filter(
        (membership) => membershipOrgId(membership) === payload.sso,
      );
      (user as any).ssoOrganizationId = payload.sso;
    }

    // Only rows that actually grant access. A revoked invite keeps its
    // row (marked inactive) and a pending invite has one before it is
    // accepted; neither is a membership, here or anywhere else.
    const memberships = effectiveMemberships(user.organizationMemberships);

    // Attach the user's org list.
    (user as any).organizations = memberships.map(membership => ({
      id: membership.organizationId || membership.organization?.id,
      name: membership.organization?.name,
      role: membership.role,
    }));

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
    //     Reject with 403 if set but not a member.
    //   - No header + exactly one org: use that org (common case).
    //   - No header + multiple orgs: leave `currentOrganizationId`
    //     undefined. The RolesGuard / handlers must then refuse the
    //     request with a clear "Organization context required" error.
    const headerOrgId = (req.headers?.['x-organization-id'] as string) || undefined;
    if (headerOrgId) {
      if (!hasEffectiveMembership(user.organizationMemberships, headerOrgId)) {
        // 403, not 401. The session is fine — the cookie verified, the
        // token version matches, the user is active. What is wrong is one
        // request header naming an organization this caller cannot act
        // in, which is client state, not a dead session. Answering 401
        // made every web client treat it as one: the axios interceptor
        // cleared local auth state and redirected to /auth/login, so a
        // single stale org id read to the user as being signed out
        // moments after signing in. The refusal itself is unchanged — the
        // membership check still decides, and still refuses.
        //
        // The code is what makes this recoverable: a client that sees
        // ORGANIZATION_CONTEXT_INVALID drops its organization selection
        // and asks again, rather than throwing the session away.
        throw new ForbiddenException({
          code: 'ORGANIZATION_CONTEXT_INVALID',
          message: 'Not a member of the requested organization',
        });
      }
      (user as any).currentOrganizationId = headerOrgId;
    } else if (memberships.length === 1) {
      (user as any).currentOrganizationId = memberships[0].organizationId;
    } else {
      (user as any).currentOrganizationId = undefined;
    }

    return user;
  }
}