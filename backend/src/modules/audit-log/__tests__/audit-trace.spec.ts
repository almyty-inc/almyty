import { AuditLogService } from '../audit-log.service';
import { AuditAction, AuditResource } from '../../../entities/audit-log.entity';
import { runWithRequestContext } from '../../../common/request-context';

/**
 * The W3C trace context an MCP 2026-07-28 client sent in _meta is put on
 * the request scope; every audit row written inside that request carries
 * it as metadata.trace, so an operator can join our rows to the caller's
 * trace (design decision 10).
 */
describe('AuditLogService — trace context', () => {
  const trace = { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' };
  const options = { organizationId: 'org-1', action: AuditAction.UPDATE, resourceType: AuditResource.TOOL, resourceId: 'tool-1' };

  function service() {
    const auditRepo: any = { create: jest.fn((x: any) => x), save: jest.fn(async (x: any) => ({ id: 'log-1', ...x })) };
    return { svc: new AuditLogService(auditRepo, { findOne: jest.fn() } as any), auditRepo };
  }

  it('adds the request trace to the metadata', async () => {
    const { svc } = service();
    const saved: any = await runWithRequestContext({ trace }, () => svc.log({ ...options, metadata: { field: 'name' } }));
    expect(saved.metadata).toEqual({ field: 'name', trace });
  });

  it('adds it in a transaction write too', async () => {
    const { svc } = service();
    const txRepo: any = { create: jest.fn((x: any) => x), save: jest.fn(async (x: any) => x) };
    const manager: any = { getRepository: () => txRepo };
    const saved: any = await runWithRequestContext({ trace }, () => svc.logInTransaction(manager, options));
    expect(saved.metadata).toEqual({ trace });
  });

  it('leaves metadata alone outside a traced request, and keeps an explicit trace', async () => {
    const { svc } = service();
    expect(((await svc.log(options)) as any).metadata).toBeUndefined();
    const own = { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' };
    const saved: any = await runWithRequestContext({ trace }, () => svc.log({ ...options, metadata: { trace: own } }));
    expect(saved.metadata.trace).toBe(own);
  });
});
