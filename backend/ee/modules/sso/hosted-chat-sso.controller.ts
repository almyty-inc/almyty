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
import type { Request, Response } from 'express';
import { randomBytes } from 'crypto';

import { Public } from '../../../src/common/decorators/public.decorator';
import { trustedClientIp } from '../../../src/common/security/client-ip';
import type { Gateway } from '../../../src/entities/gateway.entity';
import { HostedChatService } from '../../../src/modules/gateways/channels/hosted-chat.service';
import { hostedChatConfigFrom, hostedChatUrl } from '../../../src/modules/gateways/channels/hosted-chat.config';
import { OrgLicenseResolver } from '../../../src/modules/licensing/org-license.resolver';
import { EE_ENTITLEMENTS } from '../../../src/modules/licensing/license.constants';
import { SsoService } from './sso.service';
import { ParkedSamlSignIn, PendingSamlSignIn, SamlSignInStore } from './saml-sign-in.store';

export { SAML_HANDOFF_TTL_MS, SAML_SIGN_IN_TTL_MS } from './saml-sign-in.store';

interface PendingVisitorSignIn extends PendingSamlSignIn {
  gatewayId: string;
  endUserId: string;
}

interface ParkedVisitorSignIn extends ParkedSamlSignIn {
  gatewayId: string;
  endUserId: string;
  identity: { externalId: string; email: string | null; displayName: string | null };
}

/** Keeps visitor sign-ins apart from dashboard ones in SamlSignInStore. */
const SCOPE = 'hc';

/**
 * Sign a hosted-chat visitor in through the tenant organization's own
 * identity provider, OIDC or SAML, whichever the organization's SSO is
 * configured for.
 *
 * Lives under the same public prefix as the chat API so every leg lands
 * on the tenant host (where the session cookie is scoped) through the
 * existing `/api` route, with no extra ingress.
 *
 * SAML goes through the relay-state hand-off in SamlSignInStore (shared
 * with the dashboard login): the response must answer the request this
 * sign-in made, and the identity is bound only on the follow-up GET, in
 * the browser that holds the state cookie and is the visitor that began
 * the sign-in. A response posted into someone else's browser (login CSRF)
 * binds nothing.
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
    private readonly signIns: SamlSignInStore,
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
    const relayState = SamlSignInStore.newRelayState();
    const acsUrl = HostedChatSsoController.samlAcsUrl(gateway, slug, req.headers.host);
    const { url, requestId } = await this.sso.startSamlRequest(gateway.organizationId, acsUrl, relayState);
    const pending: PendingVisitorSignIn = { gatewayId: gateway.id, endUserId: endUser.id, requestId, acsUrl };
    if (!(await this.signIns.remember(SCOPE, relayState, pending))) return res.redirect(302, '/?signin_error=SIGN_IN_UNAVAILABLE');
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
    const pending = await this.signIns.takePending<PendingVisitorSignIn>(SCOPE, relayState);
    if (!pending || pending.gatewayId !== gateway.id || !samlResponse) {
      return res.redirect(303, '/?signin_error=SIGN_IN_EXPIRED');
    }

    let identity: ParkedVisitorSignIn['identity'];
    try {
      identity = await this.sso.resolveHostedChatSamlVisitor(gateway.organizationId, samlResponse, pending.acsUrl, pending.requestId);
    } catch {
      return res.redirect(303, '/?signin_error=SIGN_IN_FAILED');
    }

    const handoff = await this.signIns.park<ParkedVisitorSignIn>(SCOPE, { relayState, gatewayId: gateway.id, endUserId: pending.endUserId, identity });
    if (!handoff) return res.redirect(303, '/?signin_error=SIGN_IN_FAILED');
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
    const record = await this.signIns.takeHandoff<ParkedVisitorSignIn>(
      SCOPE,
      handoff,
      (req as any).cookies?.[HostedChatSsoController.SAML_STATE_COOKIE],
    );
    const session = (req as any).cookies?.[HostedChatService.SESSION_COOKIE];
    if (!record || record.gatewayId !== gateway.id || !session) {
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

  /**
   * Every ACS URL samlAcsUrl can answer for this surface: its own subdomain,
   * and its verified custom domain if it has one. What the organization
   * registers at its IdP (shown on the gateway page by
   * HostedChatSsoSettingsController).
   */
  static samlAcsUrls(gateway: Pick<Gateway, 'configuration' | 'customDomain'>, slug: string): string[] {
    const urls = [HostedChatSsoController.samlAcsUrl(gateway, slug)];
    const custom = gateway.customDomain?.status === 'active' ? gateway.customDomain.hostname : null;
    if (custom) urls.push(HostedChatSsoController.samlAcsUrl(gateway, slug, custom));
    return urls;
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
