import { AuditExportService } from '../audit-export.service';
import { AuditLog } from '../../../../src/entities/audit-log.entity';

function row(partial: Partial<AuditLog>): AuditLog {
  return {
    id: 'a1',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    organizationId: 'org',
    userId: 'u1',
    userEmail: 'u@example.com',
    action: 'create' as any,
    resourceType: 'tool' as any,
    resourceId: 'r1',
    resourceName: 'My Tool',
    status: 'success',
    ipAddress: '10.0.0.1',
    details: { note: 'hi, "there"' },
    ...partial,
  } as AuditLog;
}

class FakeAuditRepo {
  rows: AuditLog[] = [];
  createQueryBuilder() {
    const self = this;
    const qb: any = {
      where: () => qb,
      andWhere: () => qb,
      orderBy: () => qb,
      take: () => qb,
      getMany: async () => self.rows,
    };
    return qb;
  }
}

function makeService() {
  const repo = new FakeAuditRepo();
  const svc = new AuditExportService(repo as any);
  return { svc, repo };
}

describe('AuditExportService', () => {
  it('exports JSON with count + attachment filename', async () => {
    const { svc, repo } = makeService();
    repo.rows = [row({ id: 'a1' }), row({ id: 'a2' })];
    const out = await svc.export('json', { organizationId: 'org' });
    expect(out.contentType).toBe('application/json');
    expect(out.filename).toMatch(/\.json$/);
    expect(out.count).toBe(2);
    const parsed = JSON.parse(out.body);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe('a1');
  });

  it('exports CSV with a header row and RFC-4180 quoting', async () => {
    const { svc, repo } = makeService();
    repo.rows = [row({ details: { note: 'a,b "c"' } })];
    const out = await svc.export('csv', { organizationId: 'org' });
    expect(out.contentType).toBe('text/csv');
    const lines = out.body.split('\n');
    expect(lines[0]).toContain('id,createdAt,organizationId');
    // One header + one data row: the embedded comma must NOT split rows.
    expect(lines).toHaveLength(2);
    // Embedded quotes are doubled per RFC 4180.
    expect(out.body).toContain('""');
  });

  it('serializes Date columns as ISO strings in CSV', async () => {
    const { svc, repo } = makeService();
    repo.rows = [row({})];
    const out = await svc.export('csv', { organizationId: 'org' });
    expect(out.body).toContain('2026-01-02T03:04:05.000Z');
  });
});
