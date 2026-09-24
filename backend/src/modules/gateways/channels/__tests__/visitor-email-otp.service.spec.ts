import { HttpStatus } from '@nestjs/common';

import {
  CODE_TTL_MS,
  MAX_ATTEMPTS,
  SEND_LIMITS,
  VisitorEmailOtpService,
  VisitorSignInError,
} from '../visitor-email-otp.service';
import { GatewayRateLimitService } from '../../gateway-rate-limit.service';
import { MailService } from '../../../mail/mail.service';
import { fakeRepository } from '../../../../test/fake-repository';
import { FakeRedisWithWindows } from '../../../../test/fake-redis-windows';

/**
 * Email sign-in codes: single use, short lived, a bounded number of
 * guesses, bound to the browser session that asked, and sent under
 * per-visitor / per-network / per-recipient ceilings (none surface-wide).
 *
 * Real MailService (its no-provider dev path records every send) and a
 * real GatewayRateLimitService over a Redis double that runs its script.
 */

const gateway: any = {
  id: 'gw-1',
  organizationId: 'org-1',
  configuration: { hostedChat: { slug: 'acme', appName: 'Acme Help', authMode: 'email_otp' } },
};
const visitor = (id: string): any => ({ id, gatewayId: 'gw-1' });

function harness() {
  const codes = fakeRepository<any>();
  // Each statement takes effect when sent and answers a round trip later,
  // as over a real connection; without that gap two "concurrent" requests
  // would run one after the other and a non-atomic read-then-write would
  // look safe.
  for (const method of ['findOne', 'insert', 'update', 'increment', 'delete'] as const) {
    const direct = codes[method];
    (codes as any)[method] = jest.fn(async (...args: any[]) => {
      const result = await direct(...args);
      await new Promise<void>((resolve) => setImmediate(resolve));
      return result;
    });
  }
  const mail = new MailService();
  const redis = new FakeRedisWithWindows();
  const limits = new GatewayRateLimitService(redis as any);
  const service = new VisitorEmailOtpService(codes as any, mail, limits);
  /** The code in the newest mail to `to`, read the way the visitor would: from the subject. */
  const lastCode = (to: string): string => {
    const sent = mail.getRecentSends().filter((s) => s.to === to);
    const match = sent[sent.length - 1]?.subject.match(/^(\d{6}) is your sign-in code/);
    if (!match) throw new Error(`no code mailed to ${to}`);
    return match[1];
  };
  return { service, codes, mail, redis, limits, lastCode };
}

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(VisitorSignInError);
    const e = err as VisitorSignInError;
    return { status: e.getStatus(), code: (e.getResponse() as any).code };
  }
  throw new Error('expected a refusal');
};

describe('VisitorEmailOtpService', () => {
  const OLD_ENV = process.env.NODE_ENV;
  beforeAll(() => {
    process.env.NODE_ENV = 'test';
  });
  afterAll(() => {
    process.env.NODE_ENV = OLD_ENV;
  });
  afterEach(() => jest.useRealTimers());

  it('mails a code, stores only a keyed hash of it, and redeems it for the address', async () => {
    const { service, codes, lastCode } = harness();
    await service.start(gateway, visitor('v1'), ' Ada@Example.COM ', 'ip-1');

    const code = lastCode('ada@example.com');
    const [row] = codes.rows();
    expect(row.email).toBe('ada@example.com');
    expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(code);

    await expect(service.verify(gateway, visitor('v1'), 'ada@example.com', code, 'ip-1')).resolves.toBe(
      'ada@example.com',
    );
  });

  it('is single use', async () => {
    const { service, lastCode } = harness();
    await service.start(gateway, visitor('v1'), 'ada@example.com', null);
    const code = lastCode('ada@example.com');
    await service.verify(gateway, visitor('v1'), 'ada@example.com', code, null);
    expect(await refusal(service.verify(gateway, visitor('v1'), 'ada@example.com', code, null))).toEqual({
      status: HttpStatus.BAD_REQUEST,
      code: 'CODE_EXPIRED',
    });
  });

  it('of two concurrent redemptions of the right code, exactly one signs in', async () => {
    const { service, lastCode } = harness();
    await service.start(gateway, visitor('v1'), 'ada@example.com', null);
    const code = lastCode('ada@example.com');
    const results = await Promise.allSettled([
      service.verify(gateway, visitor('v1'), 'ada@example.com', code, null),
      service.verify(gateway, visitor('v1'), 'ada@example.com', code, null),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it(`dies after ${MAX_ATTEMPTS} guesses, even for the right code afterwards`, async () => {
    const { service, codes, lastCode } = harness();
    await service.start(gateway, visitor('v1'), 'ada@example.com', null);
    const code = lastCode('ada@example.com');
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      expect((await refusal(service.verify(gateway, visitor('v1'), 'ada@example.com', wrong, null))).code).toBe(
        'CODE_INVALID',
      );
    }
    expect((await refusal(service.verify(gateway, visitor('v1'), 'ada@example.com', code, null))).code).toBe(
      'CODE_EXPIRED',
    );
    expect(codes.rows()[0].attempts).toBe(MAX_ATTEMPTS);
  });

  it('never spends more than the cap under concurrent guessing', async () => {
    const { service, codes, lastCode } = harness();
    await service.start(gateway, visitor('v1'), 'ada@example.com', null);
    const code = lastCode('ada@example.com');
    const wrong = code === '000000' ? '111111' : '000000';
    await Promise.allSettled(
      Array.from({ length: 12 }, () => service.verify(gateway, visitor('v1'), 'ada@example.com', wrong, null)),
    );
    expect(codes.rows()[0].attempts).toBe(MAX_ATTEMPTS);
  });

  it('expires', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    const { service, lastCode } = harness();
    await service.start(gateway, visitor('v1'), 'ada@example.com', null);
    const code = lastCode('ada@example.com');
    jest.setSystemTime(Date.now() + CODE_TTL_MS + 1000);
    expect((await refusal(service.verify(gateway, visitor('v1'), 'ada@example.com', code, null))).code).toBe(
      'CODE_EXPIRED',
    );
  });

  it('only works from the browser session that asked for it', async () => {
    const { service, lastCode } = harness();
    await service.start(gateway, visitor('v1'), 'ada@example.com', null);
    const code = lastCode('ada@example.com');
    expect((await refusal(service.verify(gateway, visitor('v2'), 'ada@example.com', code, null))).code).toBe(
      'CODE_EXPIRED',
    );
  });

  it('only for the address it was sent to', async () => {
    const { service, lastCode } = harness();
    await service.start(gateway, visitor('v1'), 'ada@example.com', null);
    const code = lastCode('ada@example.com');
    expect((await refusal(service.verify(gateway, visitor('v1'), 'eve@example.com', code, null))).code).toBe(
      'CODE_EXPIRED',
    );
  });

  it('asking again retires the earlier code', async () => {
    const { service, lastCode } = harness();
    await service.start(gateway, visitor('v1'), 'ada@example.com', null);
    const first = lastCode('ada@example.com');
    await service.start(gateway, visitor('v1'), 'ada@example.com', null);
    const second = lastCode('ada@example.com');
    if (first !== second) {
      expect((await refusal(service.verify(gateway, visitor('v1'), 'ada@example.com', first, null))).code).toBe(
        'CODE_INVALID',
      );
    }
    await expect(service.verify(gateway, visitor('v1'), 'ada@example.com', second, null)).resolves.toBe(
      'ada@example.com',
    );
  });

  it('a hash is bound to its row: copying it onto another row does not validate that row', async () => {
    const { service, codes, lastCode } = harness();
    await service.start(gateway, visitor('v1'), 'ada@example.com', null);
    const code = lastCode('ada@example.com');
    const [row] = codes.rows();
    expect(VisitorEmailOtpService.codeHash(row.id, 'ada@example.com', code)).toBe(row.codeHash);
    expect(VisitorEmailOtpService.codeHash('another-row', 'ada@example.com', code)).not.toBe(row.codeHash);
    expect(VisitorEmailOtpService.codeHash(row.id, 'eve@example.com', code)).not.toBe(row.codeHash);
  });

  describe('send limits', () => {
    it('caps one visitor, without touching anybody else on the surface', async () => {
      const { service, mail } = harness();
      for (let i = 0; i < SEND_LIMITS.perVisitor.limit; i++) {
        await service.start(gateway, visitor('v1'), `a${i}@example.com`, 'ip-1');
      }
      expect(await refusal(service.start(gateway, visitor('v1'), 'z@example.com', 'ip-1'))).toEqual({
        status: HttpStatus.TOO_MANY_REQUESTS,
        code: 'VISITOR_RATE_LIMITED',
      });
      // Not a surface-wide bucket: another visitor on another network is unaffected.
      await expect(service.start(gateway, visitor('v2'), 'b@example.com', 'ip-2')).resolves.toBeUndefined();
      expect(mail.getRecentSends()).toHaveLength(SEND_LIMITS.perVisitor.limit + 1);
    });

    it('caps one recipient, so the form cannot flood somebody else inbox', async () => {
      const { service, mail } = harness();
      for (let i = 0; i < SEND_LIMITS.perRecipient.limit; i++) {
        await service.start(gateway, visitor(`v${i}`), 'victim@example.com', `ip-${i}`);
      }
      expect((await refusal(service.start(gateway, visitor('vx'), 'victim@example.com', 'ip-x'))).code).toBe(
        'VISITOR_RATE_LIMITED',
      );
      expect(mail.getRecentSends().filter((s) => s.to === 'victim@example.com')).toHaveLength(
        SEND_LIMITS.perRecipient.limit,
      );
    });

    it('caps one network across visitors', async () => {
      const { service } = harness();
      for (let i = 0; i < SEND_LIMITS.perNetwork.limit; i++) {
        await service.start(gateway, visitor(`v${i}`), `u${i}@example.com`, 'ip-shared');
      }
      expect((await refusal(service.start(gateway, visitor('vn'), 'n@example.com', 'ip-shared'))).code).toBe(
        'VISITOR_RATE_LIMITED',
      );
    });

    it('fails closed, and sends nothing, when the counters cannot be read', async () => {
      const { service, redis, mail, codes } = harness();
      jest.spyOn(redis, 'eval').mockRejectedValue(new Error('ECONNREFUSED'));
      expect(await refusal(service.start(gateway, visitor('v1'), 'ada@example.com', 'ip-1'))).toEqual({
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: 'RATE_LIMIT_UNAVAILABLE',
      });
      expect(mail.getRecentSends()).toHaveLength(0);
      expect(codes.rows()).toHaveLength(0);
    });
  });

  it('retires a code whose mail could not be sent', async () => {
    const { service, mail, codes } = harness();
    jest.spyOn(mail, 'sendTemplate').mockResolvedValue(false);
    expect((await refusal(service.start(gateway, visitor('v1'), 'ada@example.com', null))).code).toBe(
      'EMAIL_UNAVAILABLE',
    );
    expect(codes.rows()[0].consumedAt).toBeInstanceOf(Date);
  });

  it('refuses a malformed address before counting or sending', async () => {
    const { service, mail } = harness();
    expect((await refusal(service.start(gateway, visitor('v1'), 'not-an-email', null))).code).toBe('EMAIL_INVALID');
    expect(mail.getRecentSends()).toHaveLength(0);
  });

  it('sweeps expired codes and nothing else', async () => {
    const { service, codes } = harness();
    const now = new Date();
    codes.seed({ id: 'old', expiresAt: new Date(now.getTime() - 1000) });
    codes.seed({ id: 'live', expiresAt: new Date(now.getTime() + 60_000) });
    await expect(service.sweepExpired(now)).resolves.toBe(1);
    expect(codes.rows().map((r) => r.id)).toEqual(['live']);
  });

  it('schedules the sweep on boot and stops it on shutdown', () => {
    jest.useFakeTimers();
    const { service } = harness();
    const sweep = jest.spyOn(service, 'sweepExpired').mockResolvedValue(0);
    service.onModuleInit();
    jest.advanceTimersByTime(15 * 60 * 1000);
    expect(sweep).toHaveBeenCalledTimes(1);
    service.onModuleDestroy();
    jest.advanceTimersByTime(60 * 60 * 1000);
    expect(sweep).toHaveBeenCalledTimes(1);
  });
});
