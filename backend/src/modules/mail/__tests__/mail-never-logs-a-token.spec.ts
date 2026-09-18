import { Logger } from '@nestjs/common';

import { MailService } from '../mail.service';

/**
 * An email body is credential material.
 *
 * With no `RESEND_API_KEY` the service used to log
 * `[MAIL-DEV] Body: ${options.text}` — and for a password reset that
 * string is "Reset your almyty password: <url>?token=<live token>", the
 * same shape that carries org invite tokens. So every reset token issued
 * since the last deploy sat in the pod's stdout, readable by anyone with
 * log access and valid for an hour. `send()` returned `true` on that
 * path, so nothing upstream failed and "I never got the email" read as a
 * delivery problem rather than a token on disk.
 */
describe('mail service with no provider configured', () => {
  const env = process.env.NODE_ENV;
  let logged: string[];

  const build = () => {
    logged = [];
    const service = new MailService();
    const logger: any = (service as any).logger;
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(logger, level).mockImplementation((msg: any) => {
        logged.push(String(msg));
      });
    }
    return service;
  };

  const reset = {
    to: 'someone@example.com',
    subject: 'Reset your almyty password',
    html: '<a href="https://app.almyty.com/auth/reset-password?token=SECRET-TOKEN">Reset</a>',
    text: 'Reset your almyty password: https://app.almyty.com/auth/reset-password?token=SECRET-TOKEN (expires in 1 hour)',
  };

  beforeEach(() => {
    delete process.env.RESEND_API_KEY;
  });

  afterEach(() => {
    if (env === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = env;
    jest.restoreAllMocks();
  });

  it('never logs the body, and never logs the token in any form', async () => {
    process.env.NODE_ENV = 'development';
    const service = build();

    await service.send(reset);

    const everything = logged.join('\n');
    expect(everything).not.toContain('SECRET-TOKEN');
    expect(everything).not.toContain('reset-password?token');
    expect(everything).not.toContain(reset.text);
    expect(everything).not.toContain(reset.html);
  });

  it('still says who it would have gone to, so local dev stays usable', async () => {
    process.env.NODE_ENV = 'development';
    const service = build();

    await service.send(reset);

    const everything = logged.join('\n');
    expect(everything).toContain('someone@example.com');
    expect(everything).toContain('Reset your almyty password');
  });

  it('reports success outside production, because that is the local-dev path', async () => {
    process.env.NODE_ENV = 'development';
    expect(await build().send(reset)).toBe(true);
  });

  it('reports FAILURE in production, so a misconfigured deploy cannot look like a working one', async () => {
    // Otherwise every reset and every invite reports sent and goes
    // nowhere, and the caller tells the user to check their inbox.
    process.env.NODE_ENV = 'production';
    expect(await build().send(reset)).toBe(false);
  });

  it('says at boot that email is disabled, at error level in production', async () => {
    // The boot line is written in the constructor, so it has to be
    // caught on the prototype — an instance spy installed after
    // construction has already missed it.
    process.env.NODE_ENV = 'production';
    const bootLines: string[] = [];
    const spy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((msg: any) => void bootLines.push(String(msg)));

    new MailService();

    spy.mockRestore();
    expect(bootLines.join('\n')).toMatch(/RESEND_API_KEY is not set/);
    expect(bootLines.join('\n')).toMatch(/every send will fail/i);
  });

  it('does not record a send it refused', async () => {
    process.env.NODE_ENV = 'production';
    const service = build();
    await service.send(reset);
    // The diagnostics ring buffer is what a verifier reads to decide
    // whether mail is flowing; a refusal in it would be a second lie.
    expect((service as any).recentSends).toHaveLength(0);
  });
});
