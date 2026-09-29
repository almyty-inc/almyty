import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectThrottlerStorage, ThrottlerException, ThrottlerStorage } from '@nestjs/throttler';
import * as crypto from 'crypto';

import { normalizeEmail } from '../email-normalization';

export interface AccountThrottleOptions {
  /** Bucket name; one counter per (name, account). */
  name: string;
  limit: number;
  ttlMs: number;
}

const ACCOUNT_THROTTLE = 'auth:account-throttle';

/**
 * Limit a public auth route per ACCOUNT, on top of the per-IP @Throttle.
 *
 * The per-IP limit alone lets a botnet spread guesses for one account
 * across as many addresses as it has, each staying under its own bucket:
 * a password spray or credential stuffing run against a single login, or
 * a mail bomb through forgot-password. This counts every attempt that
 * names an address, whoever sends it. Unknown addresses are counted the
 * same way as real ones, so the 429 says nothing about which exist.
 */
export const AccountThrottle = (options: AccountThrottleOptions) => SetMetadata(ACCOUNT_THROTTLE, options);

/** The counter key for an address: canonical form, hashed so no address sits in Redis. */
export function accountThrottleKey(name: string, email: string): string {
  const canonical = normalizeEmail(email.trim()).toLowerCase();
  return `account-throttle:${name}:${crypto.createHash('sha256').update(canonical).digest('hex')}`;
}

@Injectable()
export class AccountThrottleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @InjectThrottlerStorage() private readonly storage: ThrottlerStorage,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.get<AccountThrottleOptions | undefined>(ACCOUNT_THROTTLE, context.getHandler());
    if (!options) return true;

    const email = context.switchToHttp().getRequest()?.body?.email;
    // No address, nothing to count: the route's own validation refuses it.
    if (typeof email !== 'string' || !email.trim()) return true;

    const record = await this.storage.increment(
      accountThrottleKey(options.name, email),
      options.ttlMs,
      options.limit,
      options.ttlMs,
      `account-${options.name}`,
    );
    if (record.isBlocked) {
      throw new ThrottlerException('Too many attempts for this account. Try again later.');
    }
    return true;
  }
}
