import { Controller, Get, HttpException, HttpStatus, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { Public } from '../../../common/decorators/public.decorator';
import { trustedClientIp } from '../../../common/security/client-ip';
import type { Gateway } from '../../../entities/gateway.entity';
import { HostedChatService } from './hosted-chat.service';
import { VisitorOAuthError, VisitorOAuthService } from './visitor-oauth.service';

/**
 * OAuth / OIDC sign-in for a hosted chat visitor, against the surface's
 * own provider (Google, GitHub, Microsoft or any OpenID Connect issuer).
 *
 * Same public prefix as the rest of the chat API, so both the start and
 * the provider's redirect land on the tenant host where the visitor's
 * session cookie lives. The pending sign-in is bound to the visitor row
 * behind that cookie; a successful callback attaches the identity through
 * bindAuthenticatedVisitor, which rotates the session key, and the new
 * key replaces the cookie -- the same as email codes.
 *
 * A failed callback sends the browser back to the chat with a reason code
 * rather than a JSON error page, since a person is looking at it.
 */
@ApiTags('Hosted chat')
@Controller('public/chat')
@Public()
export class HostedChatOAuthController {
  constructor(
    private readonly hostedChat: HostedChatService,
    private readonly oauth: VisitorOAuthService,
  ) {}

  @Get(':slug/auth/oauth/login')
  @ApiOperation({ summary: 'Send a hosted chat visitor to the surface OAuth provider' })
  async login(@Param('slug') slug: string, @Req() req: Request, @Res() res: Response) {
    const gateway = await this.surface(slug);
    const { endUser, issuedSessionKey } = await this.hostedChat.resolveEndUser(
      gateway,
      this.session(req),
      trustedClientIp(req as any),
    );
    if (issuedSessionKey) {
      res.cookie(HostedChatService.SESSION_COOKIE, issuedSessionKey, HostedChatService.sessionCookieOptions());
    }
    try {
      const url = await this.oauth.begin(gateway, endUser, req.headers.host);
      res.redirect(302, url);
    } catch (err) {
      if (err instanceof VisitorOAuthError) return res.redirect(302, `/?signin_error=${err.code}`);
      throw err;
    }
  }

  @Get(':slug/auth/oauth/callback')
  @ApiOperation({ summary: 'Finish OAuth sign-in and bind the visitor' })
  async callback(
    @Param('slug') slug: string,
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const gateway = await this.surface(slug);
    // No new session here: a callback without the cookie that started
    // the sign-in is refused by the state check anyway, and minting a
    // fresh visitor for it would only leave an empty row behind.
    const session = this.session(req);
    const { endUser } = session
      ? await this.hostedChat.resolveEndUser(gateway, session, trustedClientIp(req as any))
      : { endUser: null };
    try {
      if (!endUser) throw new VisitorOAuthError('SIGN_IN_EXPIRED', 'no session cookie');
      const identity = await this.oauth.finish(gateway, endUser, query);
      const bound = await this.hostedChat.bindAuthenticatedVisitor(gateway, endUser, {
        provider: 'oauth',
        externalId: identity.externalId,
        // An address the provider did not verify is not recorded as theirs.
        email: identity.emailVerified ? identity.email : null,
        displayName: identity.displayName,
      });
      res.cookie(HostedChatService.SESSION_COOKIE, bound.issuedSessionKey, HostedChatService.sessionCookieOptions());
      return res.redirect(302, '/');
    } catch (err) {
      if (err instanceof VisitorOAuthError) return res.redirect(302, `/?signin_error=${err.code}`);
      throw err;
    }
  }

  /** The surface must exist and be set to OAuth sign-in. */
  private async surface(slug: string): Promise<Gateway> {
    const gateway = await this.hostedChat.findBySlug(slug);
    if (this.hostedChat.authMode(gateway) !== 'oauth') {
      throw new HttpException(
        { code: 'AUTH_MODE_MISMATCH', message: 'This chat does not use OAuth sign-in.' },
        HttpStatus.BAD_REQUEST,
      );
    }
    return gateway;
  }

  private session(req: Request): string | undefined {
    return (req as any).cookies?.[HostedChatService.SESSION_COOKIE];
  }
}
