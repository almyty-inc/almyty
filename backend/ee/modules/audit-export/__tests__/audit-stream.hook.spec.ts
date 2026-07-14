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
    const license = { has: jest.fn((f: string) => entitled && f === 'audit_export') };
    const hook = new AuditStreamHookImpl(streams as any, license as any);
    return { hook, streams, license };
  }

  it('dispatches the event when entitled', async () => {
    const { hook, streams, license } = make(true);

    await hook.afterAuditWrite(event);

    expect(license.has).toHaveBeenCalledWith('audit_export');
    expect(streams.dispatch).toHaveBeenCalledTimes(1);
    expect(streams.dispatch).toHaveBeenCalledWith(event);
  });

  it('is a no-op without the audit_export entitlement', async () => {
    const { hook, streams } = make(false);

    await hook.afterAuditWrite(event);

    expect(streams.dispatch).not.toHaveBeenCalled();
  });
});
