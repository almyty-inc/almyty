import {
  renderEmailTemplate,
  renderBaseLayout,
  hasEmailTemplate,
  escapeHtml,
} from '../email-templates';
import { NOTIFICATION_EVENT_TYPES } from '../../notifications/notification-types';
import { MailService } from '../mail.service';

describe('email templates', () => {
  it('has a dedicated template for every notification event type', () => {
    // account.welcome etc. are all covered; nothing falls back to the
    // generic renderer for the known event set.
    for (const type of NOTIFICATION_EVENT_TYPES) {
      expect(hasEmailTemplate(type)).toBe(true);
    }
  });

  it('every template renders subject, branded html, and a plain-text part', () => {
    const params = {
      organizationName: 'Acme',
      inviterName: 'Ada',
      role: 'member',
      acceptUrl: 'https://app.example.com/invite/accept?token=t',
      resetUrl: 'https://app.example.com/reset?token=t',
      verifyUrl: 'https://app.example.com/verify?token=t',
      dashboardUrl: 'https://app.example.com/dashboard',
      approvalUrl: 'https://app.example.com/approvals/1',
      runUrl: 'https://app.example.com/approvals/1',
      agentUrl: 'https://app.example.com/agents/1',
      firstName: 'Ada',
      reason: 'because',
      status: 'approved',
      agentName: 'My Agent',
      error: 'boom',
      level: 'soft',
      spent: '$5.00',
      limit: '$10.00',
      pct: 50,
      scope: 'your organization',
      periodType: 'month',
      behavior: 'warn_log',
      days: 14,
      banked: false,
      kind: 'sso',
      detail: 'saml',
      memberEmail: 'left@example.com',
      totalDeleted: 42,
      summary: '42 runs',
    };

    for (const type of NOTIFICATION_EVENT_TYPES) {
      const rendered = renderEmailTemplate(type, params);
      expect(rendered.subject.length).toBeGreaterThan(0);
      expect(rendered.subject).not.toMatch(/[\r\n]/);
      // Branded base layout: wordmark + violet primary, inline CSS only.
      expect(rendered.html).toContain('almyty');
      expect(rendered.html).toContain('#7C3AED');
      expect(rendered.html).not.toMatch(/<link|<script|https?:\/\/(fonts|cdn)\./);
      // Plain-text alternative present and single-line safe.
      expect(rendered.text.length).toBeGreaterThan(0);
      expect(rendered.text).not.toMatch(/[\r\n]/);
    }
  });

  it('escapes user-supplied values (stored-XSS defense)', () => {
    const rendered = renderEmailTemplate('invite.received', {
      inviterName: '<a href="http://phishing.example">Click to verify</a>',
      organizationName: 'Acme<script>alert(1)</script>',
      role: 'member',
      acceptUrl: 'https://app.example.com/invite?token=t',
    });
    expect(rendered.html).not.toContain('<a href="http://phishing.example">');
    expect(rendered.html).not.toContain('<script>');
    expect(rendered.html).toContain('&lt;script&gt;');
  });

  it('renders the CTA button with the target URL', () => {
    const rendered = renderEmailTemplate('account.password_reset', {
      resetUrl: 'https://app.example.com/auth/reset-password?token=abc',
    });
    expect(rendered.html).toContain('https:&#x2F;&#x2F;app.example.com&#x2F;auth&#x2F;reset-password?token=abc');
    expect(rendered.text).toContain('https://app.example.com/auth/reset-password?token=abc');
  });

  it('unknown templates fall back to a generic branded email', () => {
    const rendered = renderEmailTemplate('future.event', {
      title: 'Something happened',
      body: 'details',
    });
    expect(rendered.subject).toBe('Something happened');
    expect(rendered.html).toContain('almyty');
  });

  it('renderBaseLayout shows the org context in the footer', () => {
    const html = renderBaseLayout({
      heading: 'H',
      bodyHtml: '<p>b</p>',
      orgName: 'Acme & Co',
    });
    expect(html).toContain('Sent for Acme &amp; Co');
  });

  it('escapeHtml handles null/undefined', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('MailService (template integration, dev mode: no RESEND_API_KEY)', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.RESEND_API_KEY;
    delete process.env.MAIL_FROM;
    delete process.env.EMAIL_FROM;
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it('defaults the sender to MAIL_FROM > EMAIL_FROM > notifications@almyty.com', () => {
    expect((new MailService() as any).fromEmail).toBe('almyty <notifications@almyty.com>');

    process.env.EMAIL_FROM = 'almyty <legacy@almyty.com>';
    expect((new MailService() as any).fromEmail).toBe('almyty <legacy@almyty.com>');

    process.env.MAIL_FROM = 'almyty <notifications@almyty.com>';
    expect((new MailService() as any).fromEmail).toBe('almyty <notifications@almyty.com>');
  });

  it('sendTemplate renders the template and delegates to send()', async () => {
    const service = new MailService();
    const spy = jest.spyOn(service, 'send');

    await service.sendTemplate('to@example.com', 'account.verify_email', {
      verifyUrl: 'https://app.example.com/auth/verify-email?token=t',
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const args = spy.mock.calls[0][0];
    expect(args.to).toBe('to@example.com');
    expect(args.subject).toBe('Verify your email for almyty');
    expect(args.html).toContain('#7C3AED');
    expect(args.text).toContain('https://app.example.com/auth/verify-email?token=t');
  });

  it('sendInvitation keeps its signature and routes through the branded template', async () => {
    const service = new MailService();
    const spy = jest.spyOn(service, 'send');

    const ok = await service.sendInvitation({
      to: 'invitee@example.com',
      organizationName: 'Acme',
      inviterName: 'Ada',
      role: 'member',
      inviteToken: 'tok&en',
      isNewUser: false,
    });

    expect(ok).toBe(true);
    const args = spy.mock.calls[0][0];
    expect(args.subject).toContain("You're invited to Acme");
    // Token URL-encoded into the accept link.
    expect(args.text).toContain('token=tok%26en');
    expect(args.html).toContain('#7C3AED');
  });

  it('sendPasswordReset keeps its signature and routes through the branded template', async () => {
    const service = new MailService();
    const spy = jest.spyOn(service, 'send');

    await service.sendPasswordReset('u@example.com', 'reset-token');

    const args = spy.mock.calls[0][0];
    expect(args.subject).toBe('Reset your almyty password');
    expect(args.text).toContain('reset-password?token=reset-token');
  });

  it('sendEmailVerification builds the frontend link with the encoded token', async () => {
    const service = new MailService();
    const spy = jest.spyOn(service, 'send');

    await service.sendEmailVerification('u@example.com', 'a b', 'Ada');

    const args = spy.mock.calls[0][0];
    expect(args.text).toContain('verify-email?token=a%20b');
  });
});
