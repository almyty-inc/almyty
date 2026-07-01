import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { EntitlementGuard } from '../../licensing/guards/entitlement.guard';
import { LicenseService } from '../../licensing/license.service';
import { EE_ENTITLEMENTS } from '../../licensing/license.constants';
import { AuditExportController } from '../audit-export.controller';

function ctxFor(controller: any, method: string): ExecutionContext {
  return {
    getHandler: () => controller.prototype[method],
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => ({}) }),
  } as unknown as ExecutionContext;
}

describe('AuditExportController entitlement gate', () => {
  const reflector = new Reflector();

  it('blocks with 402 in the community edition', () => {
    const svc = new LicenseService();
    svc.load({ token: '' });
    const guard = new EntitlementGuard(reflector, svc);
    try {
      guard.canActivate(ctxFor(AuditExportController, 'download'));
      fail('expected 402');
    } catch (e) {
      expect((e as HttpException).getStatus()).toBe(HttpStatus.PAYMENT_REQUIRED);
      const body = (e as HttpException).getResponse() as any;
      expect(body.requiredEntitlements).toContain(EE_ENTITLEMENTS.AUDIT_EXPORT);
    }
  });

  it('allows when audit_export is licensed', () => {
    const svc = new LicenseService();
    jest.spyOn(svc, 'has').mockImplementation((f) => f === EE_ENTITLEMENTS.AUDIT_EXPORT);
    const guard = new EntitlementGuard(reflector, svc);
    expect(guard.canActivate(ctxFor(AuditExportController, 'listStreams'))).toBe(true);
  });
});
