import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, MoreThan, Repository } from 'typeorm';
import { createHash, createHmac, randomInt, randomUUID, timingSafeEqual } from 'crypto';

import { VisitorEmailCode } from '../../../entities/visitor-email-code.entity';
import type { Gateway } from '../../../entities/gateway.entity';
import type { EndUser } from '../../../entities/end-user.entity';
import { MailService } from '../../mail/mail.service';
import { GatewayRateLimitService } from '../gateway-rate-limit.service';
import { hostedChatConfigFrom } from './hosted-chat.config';

/**
 * Email sign-in for hosted-chat surfaces set to `email_otp`.
 *
 * A visitor asks for a code for an address; we mail a six-digit code and
 * keep only a keyed hash of it. The code works once, for ten minutes, for
 * five guesses, and only from the browser session that asked for it. Every
 * one of those rules is a conditional UPDATE that Postgres evaluates
 * atomically, not a read followed by a write, so two concurrent requests
 * cannot both spend the last guess or both redeem the code.
 *
 * Sending is rate limited per visitor, per address (network) and per
 * recipient, each its own bucket. There is deliberately no surface-wide
 * bucket: one abusive visitor must not be able to lock everyone else out.
 * The per-recipient bucket is what keeps the form from being used to
 * flood somebody else's inbox.
 */

export const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_ATTEMPTS = 5;

/** Send ceilings. Each is a separate counter; none is surface-wide. */
export const SEND_LIMITS = Object.freeze({
  perVisitor: { limit: 3, seconds: 15 * 60 },
  perNetwork: { limit: 10, seconds: 60 * 60 },
  perRecipient: { limit: 5, seconds: 60 * 60 },
});

/** Verify ceilings on top of the per-code attempt cap: new codes do not reset these. */
export const VERIFY_LIMITS = Object.freeze({
  perVisitor: { limit: 15, seconds: 60 * 60 },
  perNetwork: { limit: 40, seconds: 60 * 60 },
});

const SWEEP_EVERY_MS = 15 * 60 * 1000;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class VisitorSignInError extends HttpException {
  constructor(code: string, message: string, status: HttpStatus, retryAfterSeconds?: number) {
    super({ code, message, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) }, status);
  }
}

@Injectable()
export class VisitorEmailOtpService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VisitorEmailOtpService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(VisitorEmailCode)
    private readonly codes: Repository<VisitorEmailCode>,
    private readonly mail: MailService,
    private readonly limits: GatewayRateLimitService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      this.sweepExpired().catch((err) => this.logger.warn(`Sign-in code sweep failed: ${err?.message ?? err}`));
    }, SWEEP_EVERY_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** A deliverable-looking address in canonical form, or null. */
  static normalizeEmail(input: unknown): string | null {
    if (typeof input !== 'string') return null;
    const value = input.trim().toLowerCase();
    if (!value || value.length > 254 || !EMAIL.test(value)) return null;
    return value;
  }

  /**
   * Keyed hash of a code, bound to its row and address so a hash cannot be
   * moved to another row. The key is derived from the server secret with a
   * purpose label, so it is not the JWT signing key itself.
   */
  static codeHash(rowId: string, email: string, code: string): string {
    const secret = process.env.VISITOR_OTP_SECRET || process.env.JWT_SECRET || 'dev-only-visitor-otp-key';
    const key = createHash('sha256').update(`almyty:visitor-email-otp:${secret}`).digest();
    return createHmac('sha256', key).update(`${rowId}\n${email}\n${code}`).digest('hex');
  }

  /** Ask for a code. Resolves when the mail is handed off; throws a VisitorSignInError otherwise. */
  async start(gateway: Gateway, endUser: EndUser, rawEmail: unknown, clientHash: string | null): Promise<void> {
    const email = VisitorEmailOtpService.normalizeEmail(rawEmail);
    if (!email) {
      throw new VisitorSignInError('EMAIL_INVALID', 'Enter a valid email address.', HttpStatus.BAD_REQUEST);
    }

    const recipient = createHash('sha256').update(email).digest('hex').slice(0, 32);
    const buckets = [
      { key: `otp_send:${gateway.id}:visitor:${endUser.id}`, ...SEND_LIMITS.perVisitor, what: 'you' },
      { key: `otp_send:${gateway.id}:email:${recipient}`, ...SEND_LIMITS.perRecipient, what: 'this address' },
    ];
    if (clientHash) buckets.push({ key: `otp_send:${gateway.id}:ip:${clientHash}`, ...SEND_LIMITS.perNetwork, what: 'your network' });
    await this.enforce(buckets);

    const now = new Date();
    // Only the newest code works: asking again retires the earlier ones.
    await this.codes.update(
      { gatewayId: gateway.id, endUserId: endUser.id, consumedAt: IsNull() },
      { consumedAt: now },
    );

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const id = randomUUID();
    // insert, not save: a fresh row, never an upsert onto an existing id.
    await this.codes.insert({
      id,
      organizationId: gateway.organizationId,
      gatewayId: gateway.id,
      endUserId: endUser.id,
      email,
      clientHash,
      codeHash: VisitorEmailOtpService.codeHash(id, email, code),
      attempts: 0,
      expiresAt: new Date(now.getTime() + CODE_TTL_MS),
      consumedAt: null,
      createdAt: now,
    });

    const sent = await this.mail.sendTemplate(email, 'visitor.sign_in_code', {
      appName: hostedChatConfigFrom(gateway.configuration).appName,
      code,
      minutes: CODE_TTL_MS / 60_000,
    });
    if (!sent) {
      // A code nobody received must not stay redeemable.
      await this.codes.update({ id, consumedAt: IsNull() }, { consumedAt: new Date() });
      throw new VisitorSignInError(
        'EMAIL_UNAVAILABLE',
        'We could not send the code right now. Please try again shortly.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  /**
   * Redeem a code. Resolves with the verified address exactly once per
   * code; every failure is a VisitorSignInError with a stable code.
   */
  async verify(
    gateway: Gateway,
    endUser: EndUser,
    rawEmail: unknown,
    rawCode: unknown,
    clientHash: string | null,
  ): Promise<string> {
    const email = VisitorEmailOtpService.normalizeEmail(rawEmail);
    const code = typeof rawCode === 'string' ? rawCode.replace(/\s+/g, '') : '';
    const invalid = () =>
      new VisitorSignInError('CODE_INVALID', 'That code is not right. Check it, or ask for a new one.', HttpStatus.BAD_REQUEST);

    const buckets = [{ key: `otp_verify:${gateway.id}:visitor:${endUser.id}`, ...VERIFY_LIMITS.perVisitor, what: 'you' }];
    if (clientHash) buckets.push({ key: `otp_verify:${gateway.id}:ip:${clientHash}`, ...VERIFY_LIMITS.perNetwork, what: 'your network' });
    await this.enforce(buckets);

    if (!email || !/^\d{6}$/.test(code)) throw invalid();

    const now = new Date();
    const row = await this.codes.findOne({
      where: {
        gatewayId: gateway.id,
        endUserId: endUser.id,
        email,
        consumedAt: IsNull(),
        expiresAt: MoreThan(now),
      },
      order: { createdAt: 'DESC' },
    });
    if (!row) {
      throw new VisitorSignInError(
        'CODE_EXPIRED',
        'That code has expired or was already used. Ask for a new one.',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Spend a guess before looking at the code, atomically: the row only
    // takes the increment while it is live and under the cap.
    const spent = await this.codes.increment(
      { id: row.id, consumedAt: IsNull(), expiresAt: MoreThan(now), attempts: LessThan(MAX_ATTEMPTS) },
      'attempts',
      1,
    );
    if (!spent.affected) {
      throw new VisitorSignInError(
        'CODE_EXPIRED',
        'Too many wrong codes. Ask for a new one.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const expected = Buffer.from(row.codeHash, 'hex');
    const actual = Buffer.from(VisitorEmailOtpService.codeHash(row.id, email, code), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw invalid();

    // Single use: of two requests carrying the right code, one redeems it.
    const redeemed = await this.codes.update({ id: row.id, consumedAt: IsNull() }, { consumedAt: new Date() });
    if (!redeemed.affected) {
      throw new VisitorSignInError(
        'CODE_EXPIRED',
        'That code has expired or was already used. Ask for a new one.',
        HttpStatus.BAD_REQUEST,
      );
    }
    return email;
  }

  /** Remove codes past their expiry; they can no longer be redeemed. */
  async sweepExpired(now: Date = new Date()): Promise<number> {
    const result = await this.codes.delete({ expiresAt: LessThan(now) });
    return result.affected ?? 0;
  }

  private async enforce(buckets: Array<{ key: string; limit: number; seconds: number; what: string }>): Promise<void> {
    const result = await this.limits.checkAction(buckets);
    if (!result.limited) return;
    throw new VisitorSignInError(
      result.code ?? 'VISITOR_RATE_LIMITED',
      result.message ?? 'Too many attempts. Please wait a moment.',
      result.code === 'RATE_LIMIT_UNAVAILABLE' ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.TOO_MANY_REQUESTS,
      result.retryAfterSeconds,
    );
  }
}
