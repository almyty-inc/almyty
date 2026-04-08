import { Injectable, Logger } from '@nestjs/common';
import { Resend } from 'resend';

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
    this.fromEmail = process.env.EMAIL_FROM || 'almyty <noreply@almyty.com>';

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
   * HTML-escape a string so it can be safely interpolated into an
   * email template. Previously invitation emails interpolated the
   * inviter's name and the organization's name (both user-supplied)
   * directly into the HTML body — an inviter named
   *   `<a href="http://phishing.com">Click to verify</a>`
   * could rewrite the legitimate accept button into a phishing link
   * in every recipient's inbox. Stored XSS in email bodies is also
   * real in clients that render HTML + JS (some webmail previews).
   */
  private escapeHtml(value: string): string {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
      .replace(/\//g, '&#x2F;');
  }

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

    // Escape every user-supplied value before HTML interpolation.
    const safeInviterName = this.escapeHtml(params.inviterName);
    const safeOrgName = this.escapeHtml(params.organizationName);
    const safeRole = this.escapeHtml(params.role);
    // The URL is built from the invite token (random base64url) and
    // our own baseUrl, so it's already safe, but escape it too for
    // belt-and-braces rendering inside the href attribute.
    const safeUrl = this.escapeHtml(acceptUrl);

    return this.send({
      to: params.to,
      // Email subjects aren't HTML, but the raw orgName could still
      // contain newlines that would break header formatting. Strip
      // CR/LF before interpolating.
      subject: `You're invited to ${params.organizationName.replace(/[\r\n]/g, ' ')} on almyty`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
          <h2 style="color: #8b5cf6; margin-bottom: 8px;">almyty</h2>
          <p style="font-size: 16px; color: #18181b;">
            <strong>${safeInviterName}</strong> invited you to join
            <strong>${safeOrgName}</strong> as <strong>${safeRole}</strong>.
          </p>
          <a href="${safeUrl}"
             style="display: inline-block; background: #8b5cf6; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; margin: 24px 0;">
            ${params.isNewUser ? 'Create Account &amp; Join' : 'Accept Invitation'}
          </a>
          <p style="font-size: 13px; color: #71717a;">
            This invitation expires in 7 days. If you didn't expect this, you can ignore it.
          </p>
          <p style="font-size: 12px; color: #a1a1aa; margin-top: 32px;">
            almyty — The open platform for AI agents
          </p>
        </div>
      `,
      // The plain-text alternative doesn't go through HTML rendering
      // but we still want to prevent newline injection that could
      // break MIME boundaries in some mail clients.
      text: `${params.inviterName} invited you to join ${params.organizationName} as ${params.role}. Accept: ${acceptUrl}`
        .replace(/[\r\n]+/g, ' '),
    });
  }
}
