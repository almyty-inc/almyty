import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerException, ThrottlerStorageService } from '@nestjs/throttler';

import { AccountThrottleGuard } from '../guards/account-throttle.guard';
import { AuthController } from '../auth.controller';

type Handler = (...args: never[]) => unknown;

/**
 * The per-IP limit on login, forgot-password and the unauthenticated
 * verification resend is one bucket per address. An attacker with many
 * addresses stays under every one of them while aiming all attempts at a
 * single account. These routes are also limited per account.
 */
describe('per-account limits on the public auth routes', () => {
  const contextFor = (handler: Handler, email: unknown): ExecutionContext =>
    ({
      getHandler: () => handler,
      getClass: () => AuthController,
      switchToHttp: () => ({ getRequest: () => ({ body: { email }, headers: {} }) }),
    }) as any;

  let storage: ThrottlerStorageService;
  let guard: AccountThrottleGuard;

  beforeEach(() => {
    storage = new ThrottlerStorageService();
    guard = new AccountThrottleGuard(new Reflector(), storage);
  });

  afterEach(() => storage.onApplicationShutdown());

  async function attempts(handler: Handler, email: string, count: number): Promise<number> {
    let allowed = 0;
    for (let i = 0; i < count; i++) {
      try {
        await guard.canActivate(contextFor(handler, email));
        allowed += 1;
      } catch (err) {
        expect(err).toBeInstanceOf(ThrottlerException);
      }
    }
    return allowed;
  }

  it('stops the eleventh login attempt for one account within the window', async () => {
    expect(await attempts(AuthController.prototype.login, 'victim@example.com', 15)).toBe(10);
  });

  it('counts the spellings of one mailbox as one account', async () => {
    const login = AuthController.prototype.login;
    await attempts(login, 'victim@gmail.com', 5);
    await attempts(login, 'Vic.Tim+x@gmail.com', 5);
    expect(await attempts(login, ' VICTIM@googlemail.com ', 1)).toBe(0);
  });

  it('keeps other accounts, and other routes, in their own buckets', async () => {
    await attempts(AuthController.prototype.login, 'victim@example.com', 12);
    expect(await attempts(AuthController.prototype.login, 'someone-else@example.com', 1)).toBe(1);
    expect(await attempts(AuthController.prototype.forgotPassword, 'victim@example.com', 1)).toBe(1);
  });

  it('allows three reset mails and three verification resends per account per hour', async () => {
    expect(await attempts(AuthController.prototype.forgotPassword, 'victim@example.com', 5)).toBe(3);
    expect(await attempts(AuthController.prototype.resendVerificationByEmail, 'victim@example.com', 5)).toBe(3);
  });

  it('treats an address with no account exactly like one with an account', async () => {
    // The guard never looks the address up, so a 429 is no existence oracle.
    expect(await attempts(AuthController.prototype.login, 'nobody-here@example.com', 11)).toBe(10);
  });

  it('is wired onto exactly the routes it protects, ahead of the password check', () => {
    const guardsOf = (handler: Handler) => Reflect.getMetadata('__guards__', handler) ?? [];
    expect(guardsOf(AuthController.prototype.login)[0]).toBe(AccountThrottleGuard);
    expect(guardsOf(AuthController.prototype.forgotPassword)).toContain(AccountThrottleGuard);
    expect(guardsOf(AuthController.prototype.resendVerificationByEmail)).toContain(AccountThrottleGuard);
  });
});
