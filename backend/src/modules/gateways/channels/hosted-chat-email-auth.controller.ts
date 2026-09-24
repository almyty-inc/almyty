import { Body, Controller, HttpCode, HttpException, HttpStatus, Param, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { Public } from '../../../common/decorators/public.decorator';
import { trustedClientIp } from '../../../common/security/client-ip';
import type { Gateway } from '../../../entities/gateway.entity';
import { HostedChatService } from './hosted-chat.service';
import { VisitorEmailOtpService, VisitorSignInError } from './visitor-email-otp.service';

/**
 * Email-code sign-in for a hosted chat visitor.
 *
 * Same public prefix as the rest of the chat API, so it lands on the
 * tenant host where the visitor's session cookie lives. The code is bound
 * to the visitor row behind that cookie; a successful verify attaches the
 * address to the visitor through bindAuthenticatedVisitor, which rotates
 * the session key, and the new key replaces the cookie.
 */
@ApiTags('Hosted chat')
@Controller('public/chat')
@Public()
export class HostedChatEmailAuthController {
  constructor(
    private readonly hostedChat: HostedChatService,
    private readonly otp: VisitorEmailOtpService,
  ) {}

  @Post(':slug/auth/email/start')
  @HttpCode(200)
  @ApiOperation({ summary: 'Email a one-time sign-in code to a hosted chat visitor' })
  async start(
    @Param('slug') slug: string,
    @Body() body: { email?: unknown },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const gateway = await this.surface(slug);
    const ip = trustedClientIp(req as any);
    const { endUser, issuedSessionKey } = await this.hostedChat.resolveEndUser(gateway, this.session(req), ip);
    if (issuedSessionKey) {
      res.cookie(HostedChatService.SESSION_COOKIE, issuedSessionKey, HostedChatService.sessionCookieOptions());
    }
    await this.withRetryAfter(res, () =>
      this.otp.start(gateway, endUser, body?.email, HostedChatService.hashClient(ip)),
    );
    return { success: true, data: { sent: true } };
  }

  @Post(':slug/auth/email/verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Redeem a sign-in code and sign the visitor in' })
  async verify(
    @Param('slug') slug: string,
    @Body() body: { email?: unknown; code?: unknown },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const gateway = await this.surface(slug);
    const ip = trustedClientIp(req as any);
    const { endUser } = await this.hostedChat.resolveEndUser(gateway, this.session(req), ip);
    const email = await this.withRetryAfter(res, () =>
      this.otp.verify(gateway, endUser, body?.email, body?.code, HostedChatService.hashClient(ip)),
    );

    const bound = await this.hostedChat.bindAuthenticatedVisitor(gateway, endUser, {
      provider: 'email_otp',
      externalId: email,
      email,
    });
    res.cookie(HostedChatService.SESSION_COOKIE, bound.issuedSessionKey, HostedChatService.sessionCookieOptions());
    return { success: true, data: { authenticated: true, email } };
  }

  /** The surface must exist and be set to email sign-in. */
  private async surface(slug: string): Promise<Gateway> {
    const gateway = await this.hostedChat.findBySlug(slug);
    if (this.hostedChat.authMode(gateway) !== 'email_otp') {
      throw new HttpException(
        { code: 'AUTH_MODE_MISMATCH', message: 'This chat does not use email sign-in.' },
        HttpStatus.BAD_REQUEST,
      );
    }
    return gateway;
  }

  private session(req: Request): string | undefined {
    return (req as any).cookies?.[HostedChatService.SESSION_COOKIE];
  }

  private async withRetryAfter<T>(res: Response, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (err instanceof VisitorSignInError) {
        const retry = (err.getResponse() as any)?.retryAfterSeconds;
        if (retry) res.setHeader('Retry-After', String(retry));
      }
      throw err;
    }
  }
}
