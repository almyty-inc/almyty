import { BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { readFileSync } from 'fs';
import { join } from 'path';

import { AuthService, maskEmail } from '../auth.service';
import { MailService } from '../../mail/mail.service';
import { UsersService } from '../../users/users.service';
import { UsersController } from '../../users/users.controller';
import { fakeRepository } from '../../../test/fake-repository';

/**
 * Changing the login address is changing who can reset the password, so:
 *   - it takes the current password;
 *   - the new address starts unverified and gets a verification link;
 *   - the old address is told, with only a hint of the new one;
 *   - `/users/me` (and the self branch of `/users/:id`) goes through the
 *     same path as `/auth/profile` -- it used to write the column directly.
 *
 * Truthful doubles: a user table that evaluates its criteria, real bcrypt,
 * a real JwtService, and the real MailService (whose dev path records
 * every send).
 */

const PASSWORD = 'correct horse battery staple';

async function harness() {
  process.env.NODE_ENV = 'test';
  const users = fakeRepository<any>([
    {
      id: 'u1',
      email: 'ada@example.com',
      normalizedEmail: 'ada@example.com',
      firstName: 'Ada',
      lastName: 'L',
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      isVerified: true,
      verifiedAt: new Date('2026-01-01'),
      verificationToken: null,
      preferences: {},
      organizationMemberships: [],
    },
    { id: 'u2', email: 'grace@example.com', normalizedEmail: 'grace@example.com' },
  ]);
  const mail = new MailService();
  const jwt = new JwtService({ secret: 'test-secret' });
  const auth = new AuthService(
    users as any,
    fakeRepository() as any,
    fakeRepository() as any,
    fakeRepository() as any,
    jwt,
    { log: jest.fn(async () => undefined) } as any,
    mail,
    {} as any,
  );
  const usersService = new UsersService(users as any, fakeRepository() as any, fakeRepository() as any);
  const controller = new UsersController(usersService, auth);
  const sentTo = (to: string) => mail.getRecentSends().filter((s) => s.to === to);
  return { users, mail, jwt, auth, controller, sentTo };
}

const self = (over: Record<string, unknown> = {}) => ({ id: 'u1', email: 'ada@example.com', ...over }) as any;

describe('changing the login address', () => {
  it('requires the current password', async () => {
    const { auth, users, mail } = await harness();
    await expect(auth.changeEmail('u1', 'new@example.com', undefined)).rejects.toMatchObject({
      response: { code: 'CURRENT_PASSWORD_REQUIRED' },
    });
    await expect(auth.changeEmail('u1', 'new@example.com', 'wrong password')).rejects.toMatchObject({
      response: { code: 'CURRENT_PASSWORD_INCORRECT' },
    });
    expect(users.row('u1')).toMatchObject({ email: 'ada@example.com', isVerified: true });
    expect(mail.getRecentSends()).toHaveLength(0);
  });

  it('moves the address, resets verification, verifies the NEW address and tells the OLD one', async () => {
    const { auth, users, sentTo, jwt } = await harness();
    await auth.changeEmail('u1', 'N.e.w+tag@gmail.com', PASSWORD);

    expect(users.row('u1')).toMatchObject({
      email: 'N.e.w+tag@gmail.com',
      normalizedEmail: 'new@gmail.com',
      isVerified: false,
      verifiedAt: null,
      verificationToken: null,
    });

    const [verify] = sentTo('N.e.w+tag@gmail.com');
    expect(verify.subject).toMatch(/Verify your email/);
    const [notice] = sentTo('ada@example.com');
    expect(notice.subject).toBe('Your almyty email address was changed');
    // Nothing verification-shaped went to the old mailbox.
    expect(sentTo('ada@example.com')).toHaveLength(1);

    // The link that went out is bound to the new address, so it cannot
    // verify some later address either.
    const token = (auth as any).mintEmailVerificationToken(users.row('u1'));
    expect(jwt.verify(token)).toMatchObject({ sub: 'u1', email: 'N.e.w+tag@gmail.com', purpose: 'email_verify' });
  });

  it('refuses an address somebody else holds, under either spelling', async () => {
    const { auth, users } = await harness();
    await expect(auth.changeEmail('u1', 'grace@example.com', PASSWORD)).rejects.toBeInstanceOf(BadRequestException);
    expect(users.row('u1')!.email).toBe('ada@example.com');
  });

  it('the same address is not a change and sends nothing', async () => {
    const { auth, mail, users } = await harness();
    await auth.changeEmail('u1', 'ada@example.com', undefined);
    expect(mail.getRecentSends()).toHaveLength(0);
    expect(users.row('u1')!.isVerified).toBe(true);
  });

  it('masks the new address in the notice to the old one', () => {
    expect(maskEmail('ada@example.com')).toBe('a**@example.com');
    expect(maskEmail('x@y.io')).toBe('x**@y.io');
  });
});

describe('PATCH /users/me goes through the same path', () => {
  it('without the current password the address does not move', async () => {
    const { controller, users } = await harness();
    await expect(controller.updateCurrentUser(self(), { email: 'new@example.com' } as any)).rejects.toMatchObject({
      response: { code: 'CURRENT_PASSWORD_REQUIRED' },
    });
    expect(users.row('u1')).toMatchObject({ email: 'ada@example.com', isVerified: true });
  });

  it('with it, the address moves unverified and both mailboxes hear about it', async () => {
    const { controller, users, sentTo } = await harness();
    const res = await controller.updateCurrentUser(self(), {
      email: 'new@example.com',
      currentPassword: PASSWORD,
      firstName: 'Augusta',
    } as any);
    expect(res.user).toMatchObject({ email: 'new@example.com', isVerified: false, firstName: 'Augusta' });
    expect(res.user).not.toHaveProperty('passwordHash');
    expect(users.row('u1')).toMatchObject({ email: 'new@example.com', isVerified: false, verifiedAt: null });
    expect(sentTo('new@example.com')).toHaveLength(1);
    expect(sentTo('ada@example.com')).toHaveLength(1);
  });

  it('a name-only edit needs no password and leaves verification alone', async () => {
    const { controller, users } = await harness();
    await controller.updateCurrentUser(self(), { firstName: 'Augusta', email: 'ada@example.com' } as any);
    expect(users.row('u1')).toMatchObject({ firstName: 'Augusta', isVerified: true });
  });

  it('refuses an SSO session outright', async () => {
    const { controller, users } = await harness();
    await expect(
      controller.updateCurrentUser(self({ ssoOrganizationId: 'org-1' }), {
        email: 'new@example.com',
        currentPassword: PASSWORD,
      } as any),
    ).rejects.toMatchObject({ response: { code: 'SSO_SESSION_CANNOT_CHANGE_EMAIL' } });
    expect(users.row('u1')!.email).toBe('ada@example.com');
  });
});

describe('no route can move a login address around changeEmail', () => {
  const read = (rel: string) => readFileSync(join(__dirname, '..', '..', '..', rel), 'utf8');

  it('UsersService.update refuses an email change instead of writing it', async () => {
    const { users } = await harness();
    const service = new UsersService(users as any, fakeRepository() as any, fakeRepository() as any);
    await expect(service.update('u1', { email: 'new@example.com' } as any)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(read('modules/users/users.service.ts')).not.toMatch(/user\.email\s*=/);
  });

  it('every self-service email route calls changeEmail', () => {
    const users = read('modules/users/users.controller.ts');
    expect(users.match(/this\.authService\.changeEmail\(/g)?.length).toBeGreaterThanOrEqual(2);
    const auth = read('modules/auth/auth.service.ts');
    const updateProfile = auth.slice(auth.indexOf('async updateProfile('), auth.indexOf('async changeEmail('));
    expect(updateProfile).toContain('this.changeEmail(');
    expect(updateProfile).not.toMatch(/user\.email\s*=\s*updateProfileDto/);
  });
});
