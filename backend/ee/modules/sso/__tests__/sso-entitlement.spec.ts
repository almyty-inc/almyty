import { ExecutionContext, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { EntitlementGuard } from '../../../../src/modules/licensing/guards/entitlement.guard';
import { ENTITLEMENT_KEY } from '../../../../src/modules/licensing/decorators/requires-entitlement.decorator';
import { LicenseService } from '../../../../src/modules/licensing/license.service';
import { EE_ENTITLEMENTS } from '../../../../src/modules/licensing/license.constants';

import { SsoController } from '../sso.controller';
import { SsoConfigController } from '../sso-config.controller';
import { ScimController } from '../scim.controller';
import { SsoConfigService } from '../sso-config.service';
import { ScimAuthGuard } from '../guards/scim-auth.guard';

/**
 * SSO is gated per organization, because that is what a plan belongs to.
 *
 * The login and SCIM routes are `@Public()`: an SSO assertion arrives with
 * no app session, and a SCIM client presents its own bearer token. But
 * JwtAuthGuard short-circuits on `@Public()` without attaching a user, so
 * an EntitlementGuard on those controllers had no organization to resolve
 * and fell back to the deployment-global license — which is community
 * unless a token sits in the environment, and the deployed API sets only
 * the license SIGNING key. Every paying customer's SAML login and every
 * Okta push got 402, after an admin had configured SSO successfully from
 * the authenticated settings screen.
 *
 * This spec previously asserted that shape, with `getRequest: () => ({})`
 * standing in for the missing user — it encoded the bug rather than
 * catching it.
 */
describe('SSO/SCIM entitlement gating', () => {
  const orgResolverStub = { entitlementsForOrg: jest.fn(), hasForOrg: jest.fn() } as any;

  describe('the authenticated admin surface', () => {
    it('still carries the guard, because a session names the org', async () => {
      expect(Reflect.getMetadata(ENTITLEMENT_KEY, SsoConfigController)).toEqual([
        EE_ENTITLEMENTS.SSO,
      ]);
    });

    it('refuses it under a community license', async () => {
      const svc = new LicenseService();
      svc.load({ token: '' });
      const guard = new EntitlementGuard(new Reflector(), svc, orgResolverStub);
      const ctx = {
        getHandler: () => () => undefined,
        getClass: () => SsoConfigController,
        switchToHttp: () => ({ getRequest: () => ({}) }),
      } as unknown as ExecutionContext;

      await expect(guard.canActivate(ctx)).rejects.toMatchObject({
        status: HttpStatus.PAYMENT_REQUIRED,
      });
    });
  });

  describe('the public login and SCIM surfaces', () => {
    it('does not carry a guard that could only consult the global license', () => {
      // Their org comes from the URL or the bearer token, and the check
      // happens where that is known.
      expect(Reflect.getMetadata(ENTITLEMENT_KEY, SsoController)).toBeUndefined();
      expect(Reflect.getMetadata(ENTITLEMENT_KEY, ScimController)).toBeUndefined();
    });

    it('refuses an SSO login for an organization without the entitlement', async () => {
      const service = new SsoConfigService(
        { findOne: jest.fn() } as any,
        undefined,
        { hasForOrg: jest.fn().mockResolvedValue(false) } as any,
      );

      await expect(service.getDecrypted('org-1')).rejects.toMatchObject({
        status: HttpStatus.PAYMENT_REQUIRED,
      });
    });

    it('serves an SSO login for an organization that has it', async () => {
      const service = new SsoConfigService(
        { findOne: jest.fn().mockResolvedValue(null) } as any,
        undefined,
        { hasForOrg: jest.fn().mockResolvedValue(true) } as any,
      );

      // Null because this org has configured nothing yet -- the point is
      // that it was not refused on billing grounds.
      await expect(service.getDecrypted('org-1')).resolves.toBeNull();
    });

    it('checks SCIM entitlement after the token says which organization it is', async () => {
      const hasForOrg = jest.fn().mockResolvedValue(false);
      const guard = new ScimAuthGuard(
        { findOrgByScimToken: jest.fn().mockResolvedValue('org-1') } as any,
        { hasForOrg } as any,
      );
      const ctx = {
        switchToHttp: () => ({ getRequest: () => ({ headers: { authorization: 'Bearer tok' } }) }),
      } as unknown as ExecutionContext;

      await expect(guard.canActivate(ctx)).rejects.toMatchObject({
        status: HttpStatus.PAYMENT_REQUIRED,
      });
      // Resolved first, then asked -- the old order asked before anything
      // knew which org this was.
      expect(hasForOrg).toHaveBeenCalledWith('org-1', EE_ENTITLEMENTS.SSO);
    });

    it('lets an entitled SCIM client through, with the org attached', async () => {
      const guard = new ScimAuthGuard(
        { findOrgByScimToken: jest.fn().mockResolvedValue('org-1') } as any,
        { hasForOrg: jest.fn().mockResolvedValue(true) } as any,
      );
      const req: any = { headers: { authorization: 'Bearer tok' } };
      const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;

      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(req.scimOrgId).toBe('org-1');
    });

    it('still rejects a bad token before asking about billing', async () => {
      const hasForOrg = jest.fn();
      const guard = new ScimAuthGuard(
        { findOrgByScimToken: jest.fn().mockResolvedValue(null) } as any,
        { hasForOrg } as any,
      );
      const ctx = {
        switchToHttp: () => ({ getRequest: () => ({ headers: { authorization: 'Bearer nope' } }) }),
      } as unknown as ExecutionContext;

      await expect(guard.canActivate(ctx)).rejects.toMatchObject({
        status: HttpStatus.UNAUTHORIZED,
      });
      expect(hasForOrg).not.toHaveBeenCalled();
    });
  });
});
