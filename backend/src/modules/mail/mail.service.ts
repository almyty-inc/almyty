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
        this.logger.error(`Failed to send email to ${options.to}: ${JSON.stringify(error)}`);
        return false;
      }

      this.logger.log(`Email sent to ${options.to} (id: ${data?.id})`);
      return true;
    } catch (err: any) {
      this.logger.error(`Email send error: ${err.message}`);
      return false;
    }
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
    const acceptUrl = params.isNewUser
      ? `${baseUrl}/auth/register?invite=${params.inviteToken}`
      : `${baseUrl}/invite/accept?token=${params.inviteToken}`;

    return this.send({
      to: params.to,
      subject: `You're invited to ${params.organizationName} on almyty`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
          <h2 style="color: #8b5cf6; margin-bottom: 8px;">almyty</h2>
          <p style="font-size: 16px; color: #18181b;">
            <strong>${params.inviterName}</strong> invited you to join
            <strong>${params.organizationName}</strong> as <strong>${params.role}</strong>.
          </p>
          <a href="${acceptUrl}"
             style="display: inline-block; background: #8b5cf6; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; margin: 24px 0;">
            ${params.isNewUser ? 'Create Account & Join' : 'Accept Invitation'}
          </a>
          <p style="font-size: 13px; color: #71717a;">
            This invitation expires in 7 days. If you didn't expect this, you can ignore it.
          </p>
          <p style="font-size: 12px; color: #a1a1aa; margin-top: 32px;">
            almyty — The open platform for AI agents
          </p>
        </div>
      `,
      text: `${params.inviterName} invited you to join ${params.organizationName} as ${params.role}. Accept: ${acceptUrl}`,
    });
  }
}
