import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { EntitlementGuard } from '../../../../src/modules/licensing/guards/entitlement.guard';
import { LicenseService } from '../../../../src/modules/licensing/license.service';
import { EE_ENTITLEMENTS } from '../../../../src/modules/licensing/license.constants';
import { ENTITLEMENT_KEY } from '../../../../src/modules/licensing/decorators/requires-entitlement.decorator';
import { ConnectionsGovernanceController } from '../connections-governance.controller';

function ctxFor(controller: any, method: string, request: any = {}): ExecutionContext {
  return {
    getHandler: () => controller.prototype[method],
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('ConnectionsGovernanceController entitlement gate', () => {
  const reflector = new Reflector();
  const methods = ['listPolicies', 'createPolicy', 'getPolicy', 'updatePolicy', 'removePolicy', 'review', 'revokeGrants', 'expiring', 'enforceExpiry', 'rotationCandidates', 'rotateDue', 'syncPrincipals', 'auditExport'];

  it('declares connections_governance on the whole controller', () => {
    expect(EE_ENTITLEMENTS.CONNECTIONS_GOVERNANCE).toBe('connections_governance');
    expect(reflector.get<string[]>(ENTITLEMENT_KEY, ConnectionsGovernanceController)).toEqual([EE_ENTITLEMENTS.CONNECTIONS_GOVERNANCE]);
    for (const method of methods) expect(typeof ConnectionsGovernanceController.prototype[method]).toBe('function');
  });

  it('blocks every route with 402 in the community edition', async () => {
    const svc = new LicenseService();
    svc.load({ token: '' });
    const guard = new EntitlementGuard(reflector, svc, { entitlementsForOrg: jest.fn(), hasForOrg: jest.fn() } as any);
    for (const method of methods) {
      try {
        await guard.canActivate(ctxFor(ConnectionsGovernanceController, method));
        fail(`expected 402 for ${method}`);
      } catch (e) {
        expect((e as HttpException).getStatus()).toBe(HttpStatus.PAYMENT_REQUIRED);
        expect(((e as HttpException).getResponse() as any).requiredEntitlements).toEqual([EE_ENTITLEMENTS.CONNECTIONS_GOVERNANCE]);
      }
    }
  });

  it('allows when the org license grants connections_governance', async () => {
    const svc = new LicenseService();
    const resolver = { entitlementsForOrg: jest.fn().mockResolvedValue({ entitlements: [EE_ENTITLEMENTS.CONNECTIONS_GOVERNANCE] }), hasForOrg: jest.fn() } as any;
    const guard = new EntitlementGuard(reflector, svc, resolver);
    expect(await guard.canActivate(ctxFor(ConnectionsGovernanceController, 'review', { user: { currentOrganizationId: 'org-1' } }))).toBe(true);
    expect(resolver.entitlementsForOrg).toHaveBeenCalledWith('org-1');
  });

  it('refuses an org whose license lacks it even when the global license has it', async () => {
    const svc = new LicenseService();
    jest.spyOn(svc, 'has').mockReturnValue(true);
    const resolver = { entitlementsForOrg: jest.fn().mockResolvedValue({ entitlements: ['sso'] }), hasForOrg: jest.fn() } as any;
    const guard = new EntitlementGuard(reflector, svc, resolver);
    await expect(guard.canActivate(ctxFor(ConnectionsGovernanceController, 'review', { user: { currentOrganizationId: 'org-2' } }))).rejects.toMatchObject({ status: HttpStatus.PAYMENT_REQUIRED });
  });

  it('requires an organization context on every handler', async () => {
    const controller = new ConnectionsGovernanceController({} as any, {} as any);
    await expect(controller.listPolicies({ user: { id: 'u1' } })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
  });
});
