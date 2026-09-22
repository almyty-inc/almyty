import { CanonicalMemoryService } from '../canonical-memory.service';

/**
 * A memory belongs to one organization and no other.
 *
 * The controller carried JwtAuthGuard and nothing else, and every lookup
 * was by id alone, so any authenticated user on the instance could read,
 * overwrite or hard-delete another tenant's memory by pasting a uuid.
 * The service's own comment said the controller checked this. It did not.
 *
 * Asserted on the QUERY rather than through HTTP because the query is the
 * boundary: if the where clause carries the caller's scope, no route can
 * reach across a tenant however it is called.
 */
describe('memory lookups are scoped to one organization', () => {
  const rowFor = (scopeId: string) => ({
    id: 'mem-1',
    scopeId,
    scopeType: 'workspace',
    mode: 'memory',
    content: 'secret note',
    deletedAt: null,
    validUntil: null,
  });

  function serviceWith(row: any) {
    const repo = {
      findOne: jest.fn(async ({ where }: any) => (where.scopeId === row.scopeId && where.id === row.id ? row : null)),
      delete: jest.fn(),
      save: jest.fn(async (r: any) => r),
    };
    const service = Object.create(CanonicalMemoryService.prototype) as any;
    service.repo = repo;
    service.auditLog = { log: jest.fn() };
    return { service, repo };
  }

  it('reads nothing when the caller belongs to another organization', async () => {
    const { service, repo } = serviceWith(rowFor('org-owner'));

    expect(await service.get('mem-1', 'org-attacker')).toBeNull();
    // The scope is in the WHERE clause, not applied after the read.
    expect(repo.findOne).toHaveBeenCalledWith({ where: { id: 'mem-1', scopeId: 'org-attacker' } });
  });

  it('reads it for the organization that owns it', async () => {
    const { service } = serviceWith(rowFor('org-owner'));
    expect(await service.get('mem-1', 'org-owner')).not.toBeNull();
  });

  it('refuses to delete another organization\'s memory, and deletes nothing', async () => {
    const { service, repo } = serviceWith(rowFor('org-owner'));

    expect(await service.delete('mem-1', 'org-attacker', 'hard')).toBe(false);
    // A hard delete across tenants was unrecoverable, so the assertion
    // that matters is that the destructive call never happened.
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it('deletes it for the owner', async () => {
    const { service, repo } = serviceWith(rowFor('org-owner'));
    expect(await service.delete('mem-1', 'org-owner', 'hard')).toBe(true);
    expect(repo.delete).toHaveBeenCalled();
  });
});
