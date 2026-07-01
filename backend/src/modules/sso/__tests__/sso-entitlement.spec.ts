import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { EntitlementGuard } from '../../licensing/guards/entitlement.guard';
import { ENTITLEMENT_KEY } from '../../licensing/decorators/requires-entitlement.decorator';
import { LicenseService } from '../../licensing/license.service';
import { EE_ENTITLEMENTS } from '../../licensing/license.constants';

import { SsoController } from '../sso.controller';
import { SsoConfigController } from '../sso-config.controller';
import { ScimController } from '../scim.controller';

/**
 * Proves the whole SSO/SCIM surface is inert in the community build: every
 * controller carries `@RequiresEntitlement('sso')`, and the EntitlementGuard
 * refuses (402) under a community license while allowing an EE-licensed one.
 */
describe('SSO/SCIM entitlement gating', () => {
  const controllers = [SsoController, SsoConfigController, ScimController];

  it('gates every SSO/SCIM controller behind the sso entitlement', () => {
    for (const controller of controllers) {
      const meta = Reflect.getMetadata(ENTITLEMENT_KEY, controller);
      expect(meta).toEqual([EE_ENTITLEMENTS.SSO]);
    }
  });

  function contextFor(controller: any): ExecutionContext {
    return {
      getHandler: () => () => undefined,
      getClass: () => controller,
      switchToHttp: () => ({ getRequest: () => ({}) }),
    } as unknown as ExecutionContext;
  }

  it('returns 402 for every SSO/SCIM route under a community license', () => {
    const svc = new LicenseService();
    svc.load({ token: '' }); // community — no sso entitlement
    const guard = new EntitlementGuard(new Reflector(), svc);

    for (const controller of controllers) {
      let status: number | undefined;
      try {
        guard.canActivate(contextFor(controller));
        fail(`expected 402 for ${controller.name}`);
      } catch (e) {
        status = (e as HttpException).getStatus();
      }
      expect(status).toBe(HttpStatus.PAYMENT_REQUIRED);
    }
  });

  it('allows every SSO/SCIM route when the license grants sso', () => {
    const svc = new LicenseService();
    jest.spyOn(svc, 'has').mockImplementation((f: string) => f === EE_ENTITLEMENTS.SSO);
    const guard = new EntitlementGuard(new Reflector(), svc);

    for (const controller of controllers) {
      expect(guard.canActivate(contextFor(controller))).toBe(true);
    }
  });
});
