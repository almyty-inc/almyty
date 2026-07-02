import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { EntitlementGuard } from '../../../../src/modules/licensing/guards/entitlement.guard';
import { LicenseService } from '../../../../src/modules/licensing/license.service';
import { EE_ENTITLEMENTS } from '../../../../src/modules/licensing/license.constants';
import { ByoKmsController } from '../ee-stubs.controllers';

function ctxFor(controller: any, method: string): ExecutionContext {
  return {
    getHandler: () => controller.prototype[method],
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => ({}) }),
  } as unknown as ExecutionContext;
}

// compliance_pack and chargeback have been implemented and removed from this
// stub module; byo_kms (issue #239) is the only remaining gated 501 scaffold.
const cases: [any, string, string][] = [
  [ByoKmsController, 'getConfig', EE_ENTITLEMENTS.BYO_KMS],
];

describe('EE stub controllers', () => {
  const reflector = new Reflector();

  describe.each(cases)('%p', (Controller, method, entitlement) => {
    it(`gate: blocks with 402 without ${entitlement}`, () => {
      const svc = new LicenseService();
      svc.load({ token: '' });
      const guard = new EntitlementGuard(reflector, svc);
      try {
        guard.canActivate(ctxFor(Controller, method));
        fail('expected 402');
      } catch (e) {
        expect((e as HttpException).getStatus()).toBe(HttpStatus.PAYMENT_REQUIRED);
        expect(((e as HttpException).getResponse() as any).requiredEntitlements).toContain(
          entitlement,
        );
      }
    });

    it(`gate: allows with ${entitlement} licensed`, () => {
      const svc = new LicenseService();
      jest.spyOn(svc, 'has').mockImplementation((f) => f === entitlement);
      const guard = new EntitlementGuard(reflector, svc);
      expect(guard.canActivate(ctxFor(Controller, method))).toBe(true);
    });

    it('handler reports 501 not implemented once past the gate', () => {
      const instance = new Controller();
      try {
        instance[method]();
        fail('expected 501');
      } catch (e) {
        expect((e as HttpException).getStatus()).toBe(HttpStatus.NOT_IMPLEMENTED);
      }
    });
  });
});