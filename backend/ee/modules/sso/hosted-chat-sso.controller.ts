import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRedis } from '@nestjs-modules/ioredis';
import type { Request, Response } from 'express';
import { randomBytes, timingSafeEqual } from 'crypto';

import { Public } from '../../../src/common/decorators/public.decorator';
import { trustedClientIp } from '../../../src/common/security/client-ip';
import type { Gateway } from '../../../src/entities/gateway.entity';
import { HostedChatService } from '../../../src/modules/gateways/channels/hosted-chat.service';
import { hostedChatConfigFrom, hostedChatUrl } from '../../../src/modules/gateways/channels/hosted-chat.config';
import { OrgLicenseResolver } from '../../../src/modules/licensing/org-license.resolver';
import { EE_ENTITLEMENTS } from '../../../src/modules/licensing/license.constants';
import { SsoService } from './sso.service';

/** The Redis commands the SAML hand-off needs. ioredis has both. */
export interface SamlHandoffStore {
  set(key: string, value: string, px: 'PX', ttlMs: number, nx: 'NX'): Promise<string | null>;
  getdel(key: string): Promise<string | null>;
}

interface PendingSamlSignIn {
  gatewayId: string;
  endUserId: string;
  requestId: string;
  acsUrl: string;
}

interface SamlHandoff {
  relayState: string;
  gatewayId: string;
  endUserId: string;
  identity: { externalId: string; email: string | null; displayName: string | null };
}

const RELAY_PREFIX = 'hc:saml:relay:';
const HANDOFF_PREFIX = 'hc:saml:handoff:';
export const SAML_SIGN_IN_TTL_MS = 10 * 60 * 1000;
export const SAML_HANDOFF_TTL_MS = 2 * 60 * 1000;

/**
 * Sign a hosted-chat visitor in through the tenant organization's own
 * identity provider, OIDC or SAML, whichever the organization's SSO is
 * configured for.
 *
 * Lives under the same public prefix as the chat API so every leg lands
 * on the tenant host (where the session cookie is scoped) through the
 * existing `/api` route, with no extra ingress.
 *
 * SAML takes one extra step. The IdP delivers the response as a
 * cross-site form POST, which does not carry the visitor's SameSite=Lax
 * cookies, so the assertion consumer cannot see whose browser it is. It
 * validates the response (signature, timestamps, InResponseTo against the
 * request this sign-in made, and the replay cache), parks the identity
 * under a one-time hand-off for two minutes, and redirects the browser to
 * a GET on the same host. That GET does carry the cookies: it binds the
 * identity only if the browser holds the state cookie set when the
 * sign-in began and is the same visitor that began it. A response posted
 * into someone else's browser (login CSRF) therefore binds nothing.
 */
@ApiTags('Hosted chat')
@Controller('public/chat')
@Public()
export class HostedChatSsoController {
  static readonly STATE_COOKIE = 'almyty_chat_sso_state';
  static readonly SAML_STATE_COOKIE = 'almyty_chat_saml_state';

  constructor(
    private readonly hostedChat: HostedChatService,
    private readonly sso: SsoService,
    private readonly orgLicense: OrgLicenseResolver,
    @InjectRedis() private readonly redis: SamlHandoffStore,
  ) {}

  @Get(':slug/auth/sso/login')
  @ApiOperation({ summary: 'Start SSO sign-in for a hosted chat visitor' })
  async login(@Param('slug') slug: string, @Req() req: Request, @Res() res: Response) {
    const gateway = await this.surface(slug);
    if ((await this.sso.protocolFor(gateway.organizationId)) === 'saml') {
      return this.samlLogin(gateway, slug, req, res);
    }
    const redirectUri = HostedChatSsoController.callbackUrl(slug);
    const { url, state } = await this.sso.getOidcLoginUrl(gateway.organizationId, { redirectUri });
    const nonce = randomBytes(8).toString('hex');
    res.cookie(HostedChatSsoController.STATE_COOKIE, `${state}.${slug}.${nonce}`, HostedChatSsoController.stateCookieOptions());
    res.redirect(302, url);
  }

  @Get(':slug/auth/sso/callback')
  @ApiOperation({ summary: 'Finish SSO sign-in and bind the visitor' })
  async callback(
    @Param('slug') slug: string,
    @Query() query: Record<string, string>,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const gateway = await this.surface(slug);
    const raw = (req as any).cookies?.[HostedChatSsoController.STATE_COOKIE] as string | undefined;
    const [state, cookieSlug] = (raw ?? '').split('.');
    if (!state || cookieSlug !== slug || !query.state || query.state !== state) {
      throw new HttpException({ code: 'SSO_STATE_MISMATCH', message: 'Sign-in session expired or did not match. Start again.' }, HttpStatus.UNAUTHORIZED);
    }
    const redirectUri = HostedChatSsoController.callbackUrl(slug);
    const claims = await this.sso.resolveOidcClaims(gateway.organizationId, query, state, redirectUri);

    const { endUser } = await this.hostedChat.resolveEndUser(
      gateway,
      (req as any).cookies?.[HostedChatService.SESSION_COOKIE],
      trustedClientIp(req as any),
    );
    const bound = await this.hostedChat.bindAuthenticatedVisitor(gateway, endUser, {
      provider: 'sso',
      externalId: claims.sub,
      email: claims.email,
      displayName: claims.name ?? [claims.givenName, claims.familyName].filter(Boolean).join(' ') ?? null,
    });

    res.clearCookie(HostedChatSsoController.STATE_COOKIE, { path: '/' });
    res.cookie(HostedChatService.SESSION_COOKIE, bound.issuedSessionKey, HostedChatService.sessionCookieOptions());
    res.redirect(302, '/');
  }

  // ── SAML ────────────────────────────────────────────────────────────

  private async samlLogin(gateway: Gateway, slug: string, req: Request, res: Response) {
    const { endUser, issuedSessionKey } = await this.hostedChat.resolveEndUser(
      gateway,
      (req as any).cookies?.[HostedChatService.SESSION_COOKIE],
      trustedClientIp(req as any),
    );
    if (issuedSessionKey) {
      res.cookie(HostedChatService.SESSION_COOKIE, issuedSessionKey, HostedChatService.sessionCookieOptions());
    }
    const relayState = randomBytes(32).toString('hex');
    const acsUrl = HostedChatSsoController.samlAcsUrl(gateway, slug, req.headers.host);
    const { url, requestId } = await this.sso.hostedChatSamlLogin(gateway.organizationId, acsUrl, relayState);
    const pending: PendingSamlSignIn = { gatewayId: gateway.id, endUserId: endUser.id, requestId, acsUrl };
    const stored = await this.redis.set(RELAY_PREFIX + relayState, JSON.stringify(pending), 'PX', SAML_SIGN_IN_TTL_MS, 'NX');
    if (stored !== 'OK') return res.redirect(302, '/?signin_error=SIGN_IN_UNAVAILABLE');
    res.cookie(HostedChatSsoController.SAML_STATE_COOKIE, relayState, HostedChatSsoController.stateCookieOptions());
    res.redirect(302, url);
  }

  @Post(':slug/auth/sso/saml/acs')
  @ApiOperation({ summary: 'SAML assertion consumer for a hosted chat visitor' })
  async samlAcs(
    @Param('slug') slug: string,
    @Body() body: { SAMLResponse?: unknown; RelayState?: unknown },
    @Res() res: Response,
  ) {
    const gateway = await this.surface(slug);
    const relayState = typeof body?.RelayState === 'string' ? body.RelayState : '';
    const samlResponse = typeof body?.SAMLResponse === 'string' ? body.SAMLResponse : '';
    // Taken, not read: a relay state answers one response, whatever it says.
    const raw = relayState ? await this.redis.getdel(RELAY_PREFIX + relayState) : null;
    const pending = raw ? (JSON.parse(raw) as PendingSamlSignIn) : null;
    if (!pending || pending.gatewayId !== gateway.id || !samlResponse) {
      return res.redirect(303, '/?signin_error=SIGN_IN_EXPIRED');
    }

    let identity: SamlHandoff['identity'];
    try {
      identity = await this.sso.resolveHostedChatSamlVisitor(gateway.organizationId, samlResponse, pending.acsUrl, pending.requestId);
    } catch {
      return res.redirect(303, '/?signin_error=SIGN_IN_FAILED');
    }

    const handoff = randomBytes(32).toString('hex');
    const record: SamlHandoff = { relayState, gatewayId: gateway.id, endUserId: pending.endUserId, identity };
    const stored = await this.redis.set(HANDOFF_PREFIX + handoff, JSON.stringify(record), 'PX', SAML_HANDOFF_TTL_MS, 'NX');
    if (stored !== 'OK') return res.redirect(303, '/?signin_error=SIGN_IN_FAILED');
    res.redirect(303, `${HostedChatSsoController.apiPrefix()}/public/chat/${slug}/auth/sso/saml/complete?handoff=${handoff}`);
  }

  @Get(':slug/auth/sso/saml/complete')
  @ApiOperation({ summary: 'Bind a validated SAML sign-in to the browser that started it' })
  async samlComplete(
    @Param('slug') slug: string,
    @Query('handoff') handoff: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const gateway = await this.surface(slug);
    const raw = typeof handoff === 'string' && handoff ? await this.redis.getdel(HANDOFF_PREFIX + handoff) : null;
    const record = raw ? (JSON.parse(raw) as SamlHandoff) : null;
    const cookieState = (req as any).cookies?.[HostedChatSsoController.SAML_STATE_COOKIE];
    const session = (req as any).cookies?.[HostedChatService.SESSION_COOKIE];
    if (!record || record.gatewayId !== gateway.id || !sameSecret(cookieState, record.relayState) || !session) {
      return res.redirect(302, '/?signin_error=SIGN_IN_EXPIRED');
    }
    const { endUser } = await this.hostedChat.resolveEndUser(gateway, session, trustedClientIp(req as any));
    if (endUser.id !== record.endUserId) return res.redirect(302, '/?signin_error=SIGN_IN_EXPIRED');

    const bound = await this.hostedChat.bindAuthenticatedVisitor(gateway, endUser, {
      provider: 'sso',
      externalId: record.identity.externalId,
      email: record.identity.email,
      displayName: record.identity.displayName,
    });
    res.clearCookie(HostedChatSsoController.SAML_STATE_COOKIE, { path: '/' });
    res.cookie(HostedChatService.SESSION_COOKIE, bound.issuedSessionKey, HostedChatService.sessionCookieOptions());
    res.redirect(302, '/');
  }

  /** The surface must exist, be set to SSO, and belong to an entitled org. */
  private async surface(slug: string) {
    const gateway = await this.hostedChat.findBySlug(slug);
    if (this.hostedChat.authMode(gateway) !== 'sso') {
      throw new HttpException({ code: 'AUTH_MODE_MISMATCH', message: 'This chat does not use SSO sign-in.' }, HttpStatus.BAD_REQUEST);
    }
    if (!(await this.orgLicense.hasForOrg(gateway.organizationId, EE_ENTITLEMENTS.SSO))) {
      throw new HttpException({ code: 'AUTH_MODE_UNAVAILABLE', message: 'SSO sign-in is not available for this chat.' }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return gateway;
  }

  static apiPrefix(): string {
    return (process.env.HOSTED_CHAT_API_PREFIX ?? '/api').replace(/\/$/, '');
  }

  /**
   * Deterministic per-slug callback on the tenant host. Built from the
   * configured base domain, never from the request, so it is the same
   * string an admin registers at the IdP whichever host the login hit.
   */
  static callbackUrl(slug: string): string {
    return `${hostedChatUrl(slug)}${HostedChatSsoController.apiPrefix()}/public/chat/${slug}/auth/sso/callback`;
  }

  /**
   * The SAML assertion consumer URL for the host the visitor is on: the
   * surface's verified custom domain when that is the host, its own
   * subdomain otherwise. Never an arbitrary Host header.
   */
  static samlAcsUrl(gateway: Pick<Gateway, 'configuration' | 'customDomain'>, slug: string, requestHost?: string): string {
    const host = (requestHost ?? '').split(':')[0].trim().toLowerCase();
    const custom = gateway.customDomain?.status === 'active' ? gateway.customDomain.hostname : null;
    const origin = custom && host === custom ? `https://${custom}` : hostedChatUrl(hostedChatConfigFrom(gateway.configuration).slug || slug);
    return `${origin}${HostedChatSsoController.apiPrefix()}/public/chat/${slug}/auth/sso/saml/acs`;
  }

  static stateCookieOptions() {
    return {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax' as const,
      path: '/',
      maxAge: 10 * 60 * 1000,
    };
  }
}

function sameSecret(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
