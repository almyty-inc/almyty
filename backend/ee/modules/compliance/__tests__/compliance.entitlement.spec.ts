import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { EntitlementGuard } from '../../../../src/modules/licensing/guards/entitlement.guard';
import { LicenseService } from '../../../../src/modules/licensing/license.service';
import { EE_ENTITLEMENTS } from '../../../../src/modules/licensing/license.constants';
import { ComplianceController } from '../compliance.controller';

function ctxFor(controller: any, method: string): ExecutionContext {
  return {
    getHandler: () => controller.prototype[method],
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => ({}) }),
  } as unknown as ExecutionContext;
}

describe('ComplianceController entitlement gate', () => {
  const orgResolverStub = { entitlementsForOrg: jest.fn(), hasForOrg: jest.fn() } as any;
  const reflector = new Reflector();

  it('blocks with 402 in the community edition', async () => {
    const svc = new LicenseService();
    svc.load({ token: '' });
    const guard = new EntitlementGuard(reflector, svc, orgResolverStub);
    try {
      await guard.canActivate(ctxFor(ComplianceController, 'getPolicy'));
      fail('expected 402');
    } catch (e) {
      expect((e as HttpException).getStatus()).toBe(HttpStatus.PAYMENT_REQUIRED);
      const body = (e as HttpException).getResponse() as any;
      expect(body.requiredEntitlements).toContain(EE_ENTITLEMENTS.COMPLIANCE_PACK);
    }
  });

  it('allows when compliance_pack is licensed', async () => {
    const svc = new LicenseService();
    jest.spyOn(svc, 'has').mockImplementation((f) => f === EE_ENTITLEMENTS.COMPLIANCE_PACK);
    const guard = new EntitlementGuard(reflector, svc, orgResolverStub);
    expect(await guard.canActivate(ctxFor(ComplianceController, 'getReport'))).toBe(true);
  });
});
