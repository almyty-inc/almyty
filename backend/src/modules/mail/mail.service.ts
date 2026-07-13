import { Injectable, Logger } from '@nestjs/common';
import { Resend } from 'resend';

import { renderEmailTemplate } from './email-templates';

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private resend: Resend | null = null;
  private readonly fromEmail: string;

  constructor() {
    const apiKey = process.env.RESEND_API_KEY;
    // MAIL_FROM is the canonical sender env (the almyty.com domain is
    // verified in Resend). EMAIL_FROM is kept as a fallback for deploys
    // that already set it.
    this.fromEmail =
      process.env.MAIL_FROM ||
      process.env.EMAIL_FROM ||
      'almyty <notifications@almyty.com>';

    if (apiKey) {
      this.resend = new Resend(apiKey);
      this.logger.log('Mail service initialized with Resend');
    } else {
      this.logger.warn('RESEND_API_KEY not set — emails will be logged to console only');
    }
  }

  async send(options: SendEmailOptions): Promise<boolean> {
    if (!this.resend) {
      this.logger.log(`[MAIL-DEV] To: ${options.to} | Subject: ${options.subject}`);
      this.logger.log(`[MAIL-DEV] Body: ${options.text || options.html.substring(0, 200)}`);
      return true;
    }

    try {
      const { data, error } = await this.resend.emails.send({
        from: this.fromEmail,
        to: options.to,
        subject: options.subject,
        html: options.html,
        text: options.text,
      });

      if (error) {
        // Log only the shape we actually need (name + message). The
        // previous `JSON.stringify(error)` dumped the full Resend
        // error object including headers, request metadata, and any
        // fields a future SDK version decides to include. A future
        // error shape that echoes back a hint of the API key (e.g.
        // "auth failed for key re_xxxxxxxx...") would then land in
        // the logs verbatim.
        const name = (error as any)?.name ?? 'EmailError';
        const message = (error as any)?.message ?? 'Unknown error';
        this.logger.error(`Failed to send email to ${options.to}: ${name} — ${message}`);
        return false;
      }

      this.logger.log(`Email sent to ${options.to} (id: ${data?.id})`);
      return true;
    } catch (err: any) {
      this.logger.error(`Email send error: ${err.message}`);
      return false;
    }
  }

  /**
   * Render a branded template (see email-templates.ts) and send it.
   * All notification/system emails go through here so every sender
   * gets the shared base layout + plain-text alternative for free.
   */
  async sendTemplate(
    to: string,
    template: string,
    params: Record<string, any> = {},
    subjectOverride?: string,
  ): Promise<boolean> {
    const rendered = renderEmailTemplate(template, params);
    return this.send({
      to,
      subject: subjectOverride ? subjectOverride.replace(/[\r\n]+/g, ' ') : rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
  }

  /**
   * Invitation email — branded template. User-supplied values
   * (inviter/org names) are HTML-escaped inside the template layer;
   * see the stored-XSS note in email-templates.ts (an inviter named
   * `<a href="http://phishing.com">Click to verify</a>` must not be
   * able to rewrite the accept button into a phishing link).
   */
  async sendInvitation(params: {
    to: string;
    organizationName: string;
    inviterName: string;
    role: string;
    inviteToken: string;
    isNewUser: boolean;
  }): Promise<boolean> {
    const baseUrl = process.env.FRONTEND_URL || 'https://app.staging.almyty.com';
    // URL-encode the invite token before embedding it in a URL. Even
    // though the tokens are base64url (should be URL-safe), defensive
    // encoding costs nothing and prevents the `&` in a future token
    // format from fragmenting the query string.
    const encodedToken = encodeURIComponent(params.inviteToken);
    const acceptUrl = params.isNewUser
      ? `${baseUrl}/auth/register?invite=${encodedToken}`
      : `${baseUrl}/invite/accept?token=${encodedToken}`;

    return this.sendTemplate(params.to, 'invite.received', {
      organizationName: params.organizationName,
      inviterName: params.inviterName,
      role: params.role,
      isNewUser: params.isNewUser,
      acceptUrl,
    });
  }

  async sendPasswordReset(to: string, resetToken: string): Promise<boolean> {
    const baseUrl = process.env.FRONTEND_URL || 'https://app.staging.almyty.com';
    const encodedToken = encodeURIComponent(resetToken);
    const resetUrl = `${baseUrl}/auth/reset-password?token=${encodedToken}`;

    return this.sendTemplate(to, 'account.password_reset', { resetUrl });
  }

  /**
   * Email-address verification link. The token is a purpose-scoped
   * signed JWT minted by AuthService; the link lands on the frontend
   * page which calls GET /auth/verify-email?token=.
   */
  async sendEmailVerification(to: string, verifyToken: string, firstName?: string): Promise<boolean> {
    const baseUrl = process.env.FRONTEND_URL || 'https://app.staging.almyty.com';
    const encodedToken = encodeURIComponent(verifyToken);
    const verifyUrl = `${baseUrl}/auth/verify-email?token=${encodedToken}`;

    return this.sendTemplate(to, 'account.verify_email', { verifyUrl, firstName });
  }
}