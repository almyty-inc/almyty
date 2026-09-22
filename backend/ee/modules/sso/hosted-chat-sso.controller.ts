import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { randomBytes } from 'crypto';

import { Public } from '../../../src/common/decorators/public.decorator';
import { HostedChatService } from '../../../src/modules/gateways/channels/hosted-chat.service';
import { hostedChatUrl } from '../../../src/modules/gateways/channels/hosted-chat.config';
import { OrgLicenseResolver } from '../../../src/modules/licensing/org-license.resolver';
import { EE_ENTITLEMENTS } from '../../../src/modules/licensing/license.constants';
import { SsoService } from './sso.service';

/**
 * Sign a hosted-chat visitor in through the tenant organization's OIDC
 * provider.
 *
 * Lives under the same public prefix as the chat API so the callback lands
 * on the tenant host (where the session cookie is scoped) through the
 * existing `/api` route, with no extra ingress. The state cookie carries
 * the slug so a callback cannot be replayed against another surface.
 */
@ApiTags('Hosted chat')
@Controller('public/chat')
@Public()
export class HostedChatSsoController {
  static readonly STATE_COOKIE = 'almyty_chat_sso_state';

  constructor(
    private readonly hostedChat: HostedChatService,
    private readonly sso: SsoService,
    private readonly orgLicense: OrgLicenseResolver,
  ) {}

  @Get(':slug/auth/sso/login')
  @ApiOperation({ summary: 'Start SSO sign-in for a hosted chat visitor' })
  async login(@Param('slug') slug: string, @Req() req: Request, @Res() res: Response) {
    const gateway = await this.surface(slug);
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
      HostedChatSsoController.clientIp(req),
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

  /**
   * Deterministic per-slug callback on the tenant host. Built from the
   * configured base domain, never from the request, so it is the same
   * string an admin registers at the IdP whichever host the login hit.
   */
  static callbackUrl(slug: string): string {
    const prefix = (process.env.HOSTED_CHAT_API_PREFIX ?? '/api').replace(/\/$/, '');
    return `${hostedChatUrl(slug)}${prefix}/public/chat/${slug}/auth/sso/callback`;
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

  private static clientIp(req: Request): string | undefined {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0].trim();
    return req.ip;
  }
}
