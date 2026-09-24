import { CanonicalMemoryService } from '../canonical-memory.service';
import { userScopeId } from '../canonical-memory.helpers';
import { fakeRepository } from '../../../../test/fake-repository';

/**
 * A memory belongs to one organization and no other -- and a `user`
 * memory to one member of it.
 *
 * The controller carried JwtAuthGuard and nothing else, and every lookup
 * was by id alone, so any authenticated user on the instance could read,
 * overwrite or hard-delete another tenant's memory by pasting a uuid.
 * The service's own comment said the controller checked this. It did not.
 *
 * Asserted against a table that evaluates the where clause, because the
 * query is the boundary: if it carries the caller's scope, no route can
 * reach across a tenant however it is called.
 */
describe('memory lookups are scoped to one organization', () => {
  const rowFor = (scopeId: string, scopeType = 'workspace') => ({
    id: 'mem-1',
    scopeId,
    scopeType,
    mode: 'memory',
    content: 'secret note',
    deletedAt: null,
    validUntil: null,
  });

  function serviceWith(row: any) {
    const repo = fakeRepository<any>([row]);
    const service = Object.create(CanonicalMemoryService.prototype) as any;
    service.repo = repo;
    service.auditLog = { log: jest.fn() };
    return { service, repo };
  }

  it('reads nothing when the caller belongs to another organization', async () => {
    const { service } = serviceWith(rowFor('org-owner'));
    expect(await service.get('mem-1', 'org-attacker', 'user-1')).toBeNull();
  });

  it('reads it for the organization that owns it', async () => {
    const { service } = serviceWith(rowFor('org-owner'));
    expect(await service.get('mem-1', 'org-owner')).not.toBeNull();
  });

  it('refuses to delete another organization\'s memory, and deletes nothing', async () => {
    const { service, repo } = serviceWith(rowFor('org-owner'));

    expect(await service.delete('mem-1', 'org-attacker', 'hard')).toBe(false);
    // A hard delete across tenants was unrecoverable, so the assertion
    // that matters is that the row is still there.
    expect(repo.rows()).toHaveLength(1);
  });

  it('deletes it for the owner', async () => {
    const { service, repo } = serviceWith(rowFor('org-owner'));
    expect(await service.delete('mem-1', 'org-owner', 'hard')).toBe(true);
    expect(repo.rows()).toHaveLength(0);
  });

  describe('a user memory', () => {
    const aliceRow = () => rowFor(userScopeId('org-owner', 'alice'), 'user');

    it('is read and deleted by its owner', async () => {
      const { service, repo } = serviceWith(aliceRow());
      expect(await service.get('mem-1', 'org-owner', 'alice')).not.toBeNull();
      expect(await service.delete('mem-1', 'org-owner', 'hard', { user_id: 'alice' })).toBe(true);
      expect(repo.rows()).toHaveLength(0);
    });

    it('is invisible to another member of the same organization', async () => {
      const { service, repo } = serviceWith(aliceRow());
      expect(await service.get('mem-1', 'org-owner', 'bob')).toBeNull();
      expect(await service.get('mem-1', 'org-owner')).toBeNull();
      expect(await service.delete('mem-1', 'org-owner', 'hard', { user_id: 'bob' })).toBe(false);
      expect(repo.rows()).toHaveLength(1);
    });
  });
});