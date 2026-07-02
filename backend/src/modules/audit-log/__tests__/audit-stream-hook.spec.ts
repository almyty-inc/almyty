import { AuditLogService } from '../audit-log.service';
import { AuditAction, AuditResource } from '../../../entities/audit-log.entity';

/**
 * EE hook seam: after an audit row is written, the optional
 * AUDIT_STREAM_HOOK is called fire-and-forget. Without the hook (community
 * build) the write path is unchanged; a failing hook never breaks or
 * blocks the write.
 */
describe('AuditLogService — audit stream hook', () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  function makeRepos() {
    const auditRepo: any = {
      create: jest.fn((x: any) => x),
      save: jest.fn(async (x: any) => ({ id: 'log-1', ...x })),
    };
    const userRepo: any = { findOne: jest.fn() };
    return { auditRepo, userRepo };
  }

  const options = {
    organizationId: 'org-1',
    action: AuditAction.CREATE,
    resourceType: AuditResource.TOOL,
    resourceId: 'tool-1',
  };

  it('community build (no hook): write path unchanged', async () => {
    const { auditRepo, userRepo } = makeRepos();
    const svc = new AuditLogService(auditRepo, userRepo);

    const saved = await svc.log(options);

    expect(saved).toEqual(expect.objectContaining({ id: 'log-1', organizationId: 'org-1' }));
    expect(auditRepo.save).toHaveBeenCalledTimes(1);
  });

  it('calls the hook with the persisted row after a successful write', async () => {
    const { auditRepo, userRepo } = makeRepos();
    const hook = { afterAuditWrite: jest.fn(async () => undefined) };
    const svc = new AuditLogService(auditRepo, userRepo, hook);

    const saved = await svc.log(options);
    await flush();

    expect(hook.afterAuditWrite).toHaveBeenCalledTimes(1);
    expect(hook.afterAuditWrite).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'log-1', organizationId: 'org-1', action: AuditAction.CREATE }),
    );
    expect(saved).toEqual(expect.objectContaining({ id: 'log-1' }));
  });

  it('does not call the hook when the write fails', async () => {
    const { auditRepo, userRepo } = makeRepos();
    auditRepo.save.mockRejectedValue(new Error('db down'));
    const hook = { afterAuditWrite: jest.fn(async () => undefined) };
    const svc = new AuditLogService(auditRepo, userRepo, hook);

    const saved = await svc.log(options);
    await flush();

    expect(saved).toBeNull();
    expect(hook.afterAuditWrite).not.toHaveBeenCalled();
  });

  it('a rejecting hook never breaks the write (fire-and-forget)', async () => {
    const { auditRepo, userRepo } = makeRepos();
    const hook = { afterAuditWrite: jest.fn(async () => { throw new Error('SIEM unreachable'); }) };
    const svc = new AuditLogService(auditRepo, userRepo, hook);

    const saved = await svc.log(options);
    await flush();

    expect(saved).toEqual(expect.objectContaining({ id: 'log-1' }));
    expect(hook.afterAuditWrite).toHaveBeenCalledTimes(1);
  });

  it('a synchronously-throwing hook never breaks the write', async () => {
    const { auditRepo, userRepo } = makeRepos();
    const hook = {
      afterAuditWrite: jest.fn(() => { throw new Error('sync boom'); }),
    };
    const svc = new AuditLogService(auditRepo, userRepo, hook as any);

    const saved = await svc.log(options);

    expect(saved).toEqual(expect.objectContaining({ id: 'log-1' }));
  });
});
