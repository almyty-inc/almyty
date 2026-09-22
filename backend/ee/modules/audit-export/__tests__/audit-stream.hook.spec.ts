import { AuditStreamHookImpl } from '../audit-stream.hook';

/**
 * EE (audit_export): the hook bound to AUDIT_STREAM_HOOK dispatches audit
 * events to the org's SIEM targets — but only when the license grants
 * `audit_export`. Unlicensed → strict no-op (community parity).
 */
describe('AuditStreamHookImpl', () => {
  const event: any = { organizationId: 'org-1', action: 'create' };

  function make(entitled: boolean) {
    const streams = { dispatch: jest.fn(async () => []) };
    // hasForOrg, not has(): licensing here is per organization. The hook
    // used the process-global LicenseService, which is community unless
    // a license token is in the environment -- and the deployed API sets
    // only the signing key, so every EE entitlement read as false no
    // matter what the org had paid for.
    const license = { hasForOrg: jest.fn(async (_org: string, f: string) => entitled && f === 'audit_export') };
    const hook = new AuditStreamHookImpl(streams as any, license as any);
    return { hook, streams, license };
  }

  it('dispatches the event when entitled', async () => {
    const { hook, streams, license } = make(true);

    await hook.afterAuditWrite(event);

    // The org comes off the audit row itself, which is what makes this
    // per-tenant rather than per-process.
    expect(license.hasForOrg).toHaveBeenCalledWith('org-1', 'audit_export');
    expect(streams.dispatch).toHaveBeenCalledTimes(1);
    expect(streams.dispatch).toHaveBeenCalledWith(event);
  });

  it('is a no-op without the audit_export entitlement', async () => {
    const { hook, streams } = make(false);

    await hook.afterAuditWrite(event);

    expect(streams.dispatch).not.toHaveBeenCalled();
  });
});
