import { ConnectionsGovernanceService } from '../connections-governance.service';
import { AuditResource } from '../../../../src/entities/audit-log.entity';
import { fakeRepository } from '../../../../src/test/fake-repository';

/**
 * The connections audit export is an admin download. A member's private
 * connection does not exist for admins anywhere else in governance, and
 * the export must not be the way round that: its events name the
 * connection, its account and every use of it.
 */
describe('connections audit export and private connections', () => {
  const NOW = new Date('2026-09-08T03:00:00Z');
  const at = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

  const credentials = [
    { id: 'shared', organizationId: 'org-1', name: 'Team OpenAI', visibility: 'org', ownerUserId: null },
    { id: 'secret', organizationId: 'org-1', name: 'Bob personal Anthropic', visibility: 'private', ownerUserId: 'bob' },
    { id: 'mine', organizationId: 'org-1', name: 'Admin own key', visibility: 'private', ownerUserId: 'admin' },
    { id: 'orphan', organizationId: 'org-1', name: 'Nobody key', visibility: 'private', ownerUserId: null },
    // Same id space, other tenant: never consulted for org-1.
    { id: 'gone', organizationId: 'org-2', name: 'Other tenant', visibility: 'org', ownerUserId: null },
  ];
  const event = (id: string, resourceId: string, resourceName: string, hoursAgo: number, details: Record<string, unknown> = {}) => ({
    id, organizationId: 'org-1', userId: 'bob', action: 'connection_resolve', resourceType: AuditResource.CONNECTION,
    resourceId, resourceName, status: null, ipAddress: null, details, createdAt: at(hoursAgo),
  });
  const events = [
    event('e-shared', 'shared', 'Team OpenAI', 1),
    event('e-secret', 'secret', 'Bob personal Anthropic', 2, { owner: 'private' }),
    event('e-secret-validate', 'secret', 'Bob personal Anthropic', 3),
    event('e-mine', 'mine', 'Admin own key', 4, { owner: 'private' }),
    event('e-orphan', 'orphan', 'Nobody key', 5),
    // Deleted connections: judged by what their events recorded.
    event('e-gone-private', 'gone', 'Deleted private key', 6, { owner: 'private' }),
    event('e-gone-private-2', 'gone', 'Deleted private key', 7),
    event('e-deleted-org', 'deleted-org', 'Deleted org key', 8, { owner: 'org' }),
    { ...event('e-policy', 'org-1', 'connection_policy:allow', 9), resourceType: AuditResource.ORGANIZATION },
  ];

  function build() {
    const empty = () => fakeRepository<any>();
    const service = new ConnectionsGovernanceService(
      empty() as any, fakeRepository<any>(credentials) as any, empty() as any, empty() as any, empty() as any,
      fakeRepository<any>(events) as any, empty() as any,
      {} as any, { log: jest.fn() } as any, {} as any, undefined, undefined, undefined,
    );
    service.now = () => NOW;
    return service;
  }

  it("leaves members' private connections out of the export, the caller's own in", async () => {
    const result = await build().export('org-1', 'json', {}, 'admin');
    const body = JSON.parse(result.body);
    expect(body.events.map((e: any) => e.id)).toEqual(['e-shared', 'e-mine', 'e-deleted-org', 'e-policy']);
    expect(result.count).toBe(4);
    expect(result.body).not.toContain('Bob personal');
    expect(result.body).not.toContain('Deleted private');
    expect(result.body).not.toContain('Nobody key');
  });

  it('does the same in CSV, and with no known caller keeps no private connection', async () => {
    const csv = await build().export('org-1', 'csv', {}, null);
    expect(csv.body).not.toContain('Bob personal');
    expect(csv.body).not.toContain('Admin own key');
    expect(csv.body).toContain('Team OpenAI');
    expect(csv.count).toBe(3);
  });
});
