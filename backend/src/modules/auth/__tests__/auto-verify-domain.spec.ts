import { Logger } from '@nestjs/common';

import { autoVerifyEmailDomain, isOnAutoVerifyDomain } from '../auto-verify-domain';
import { AuthService } from '../auth.service';

/**
 * AUTO_VERIFY_EMAIL_DOMAIN lets a test stack's automated journeys sign up
 * and sign in without an inbox. The match has to be exact, or one
 * registration on a look-alike domain skips verification in a place it
 * was never meant to.
 */
describe('AUTO_VERIFY_EMAIL_DOMAIN', () => {
  describe('autoVerifyEmailDomain', () => {
    it('is off when unset or blank', () => {
      expect(autoVerifyEmailDomain({})).toBeNull();
      expect(autoVerifyEmailDomain({ AUTO_VERIFY_EMAIL_DOMAIN: '' })).toBeNull();
      expect(autoVerifyEmailDomain({ AUTO_VERIFY_EMAIL_DOMAIN: '   ' })).toBeNull();
    });

    it('reads the domain lower-cased, with a leading @ dropped', () => {
      expect(autoVerifyEmailDomain({ AUTO_VERIFY_EMAIL_DOMAIN: ' Test.Almyty.com ' })).toBe('test.almyty.com');
      expect(autoVerifyEmailDomain({ AUTO_VERIFY_EMAIL_DOMAIN: '@test.almyty.com' })).toBe('test.almyty.com');
    });
  });

  describe('isOnAutoVerifyDomain', () => {
    const domain = 'test.almyty.com';

    it.each(['a@test.almyty.com', 'A.B+tag@TEST.almyty.com'])('matches %s', (email) => {
      expect(isOnAutoVerifyDomain(email, domain)).toBe(true);
    });

    it.each([
      'a@evil-test.almyty.com',
      'a@test.almyty.com.evil.com',
      'a@sub.test.almyty.com',
      'a@almyty.com',
      'a@test.almyty.co',
      'test.almyty.com',
      '@test.almyty.com',
      'a@test.almyty.com@evil.com',
      '',
    ])('does not match %s', (email) => {
      expect(isOnAutoVerifyDomain(email, domain)).toBe(false);
    });

    it('matches nothing when the variable is unset', () => {
      expect(isOnAutoVerifyDomain('a@test.almyty.com', null)).toBe(false);
    });
  });

  describe('boot warning', () => {
    const saved = process.env.AUTO_VERIFY_EMAIL_DOMAIN;
    afterEach(() => {
      if (saved === undefined) delete process.env.AUTO_VERIFY_EMAIL_DOMAIN;
      else process.env.AUTO_VERIFY_EMAIL_DOMAIN = saved;
      jest.restoreAllMocks();
    });

    function bareService(): AuthService {
      return Object.create(AuthService.prototype, {
        logger: { value: new Logger('AuthService') },
      });
    }

    it('warns at boot when set', () => {
      process.env.AUTO_VERIFY_EMAIL_DOMAIN = 'test.almyty.com';
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      bareService().onModuleInit();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/AUTO_VERIFY_EMAIL_DOMAIN=test\.almyty\.com.*never set it in production/));
    });

    it('says nothing when unset', () => {
      delete process.env.AUTO_VERIFY_EMAIL_DOMAIN;
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      bareService().onModuleInit();
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
