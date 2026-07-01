import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { EntitlementGuard } from '../guards/entitlement.guard';
import { RequiresEntitlement, ENTITLEMENT_KEY } from '../decorators/requires-entitlement.decorator';
import { LicenseService } from '../license.service';
import { EE_ENTITLEMENTS } from '../license.constants';

function contextFor(handler: any): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({}) }),
  } as unknown as ExecutionContext;
}

describe('EntitlementGuard', () => {
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
  });

  it('allows routes with no @RequiresEntitlement metadata', () => {
    const svc = new LicenseService();
    svc.load({ token: '' });
    const guard = new EntitlementGuard(reflector, svc);

    const handler = () => undefined;
    expect(guard.canActivate(contextFor(handler))).toBe(true);
  });

  it('blocks with 402 when the community license lacks the entitlement', () => {
    const svc = new LicenseService();
    svc.load({ token: '' }); // community

    class Ctrl {
      @RequiresEntitlement(EE_ENTITLEMENTS.SSO)
      handler() {}
    }
    const guard = new EntitlementGuard(reflector, svc);
    const ctx = contextFor(Ctrl.prototype.handler);

    expect(() => guard.canActivate(ctx)).toThrow(HttpException);
    try {
      guard.canActivate(ctx);
    } catch (e) {
      expect((e as HttpException).getStatus()).toBe(HttpStatus.PAYMENT_REQUIRED);
    }
  });

  it('allows when the license grants the entitlement', () => {
    const svc = new LicenseService();
    // Force-grant via a stub rather than minting a token — unit isolation.
    jest.spyOn(svc, 'has').mockImplementation((f: string) => f === EE_ENTITLEMENTS.SSO);

    class Ctrl {
      @RequiresEntitlement(EE_ENTITLEMENTS.SSO)
      handler() {}
    }
    const guard = new EntitlementGuard(reflector, svc);
    expect(guard.canActivate(contextFor(Ctrl.prototype.handler))).toBe(true);
  });

  it('reports every missing entitlement when several are required', () => {
    const svc = new LicenseService();
    svc.load({ token: '' });

    class Ctrl {
      @RequiresEntitlement(EE_ENTITLEMENTS.SSO, EE_ENTITLEMENTS.BYO_KMS)
      handler() {}
    }
    const guard = new EntitlementGuard(reflector, svc);

    try {
      guard.canActivate(contextFor(Ctrl.prototype.handler));
      fail('expected guard to throw');
    } catch (e) {
      const body = (e as HttpException).getResponse() as any;
      expect(body.requiredEntitlements).toEqual([EE_ENTITLEMENTS.SSO, EE_ENTITLEMENTS.BYO_KMS]);
    }
  });

  it('decorator attaches the expected metadata', () => {
    class Ctrl {
      @RequiresEntitlement('sso')
      handler() {}
    }
    const meta = Reflect.getMetadata(ENTITLEMENT_KEY, Ctrl.prototype.handler);
    expect(meta).toEqual(['sso']);
  });
});
