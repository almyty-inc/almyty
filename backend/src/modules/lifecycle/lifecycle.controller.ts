import { Controller, Get, Header, Query } from '@nestjs/common';

import { Public } from '../../common/decorators/public.decorator';
import { escapeHtml } from '../mail/email-templates';
import { LifecycleEmailService } from './lifecycle-email.service';

/**
 * Public unsubscribe endpoint for activation lifecycle emails. Reachable
 * without a session (the recipient may not be logged in) — the signed
 * token in the query string is the only credential. A valid token opts
 * the user out; anything else renders the same neutral confirmation so we
 * never leak whether a token maps to a real account.
 */
@Controller('lifecycle')
export class LifecycleController {
  constructor(private readonly lifecycleEmails: LifecycleEmailService) {}

  @Public()
  @Get('unsubscribe')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async unsubscribe(@Query('token') token?: string): Promise<string> {
    const userId = this.lifecycleEmails.verifyUnsubToken(token ?? '');
    if (userId) {
      await this.lifecycleEmails.setOptOut(userId, true);
    }
    // Same page whether or not the token resolved: no account-existence
    // oracle, and a stale/expired link still feels like it worked.
    return this.renderConfirmation();
  }

  private renderConfirmation(): string {
    const heading = escapeHtml("You're unsubscribed");
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Unsubscribed from almyty</title>
</head>
<body style="margin:0;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:48px 16px;">
    <div style="background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;padding:40px 36px;text-align:center;">
      <div style="font-size:20px;font-weight:800;letter-spacing:-0.5px;color:#7C3AED;margin:0 0 24px;">almyty</div>
      <h1 style="font-size:20px;line-height:28px;font-weight:700;color:#18181b;margin:0 0 12px;">${heading}</h1>
      <p style="font-size:15px;line-height:24px;color:#18181b;margin:0;">You're unsubscribed from almyty activation emails. You'll still get essential account emails like password resets and security notices.</p>
    </div>
    <p style="text-align:center;font-size:12px;color:#a1a1aa;margin:20px 0 0;">almyty, the open platform for AI agents</p>
  </div>
</body>
</html>`;
  }
}
