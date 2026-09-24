import { OrganizationsService } from '../organizations.service';
import { Organization } from '../../../entities/organization.entity';
import { fakeRepository, FakeRepository } from '../../../test/fake-repository';
import { RecordingQueryBuilder } from '../../gateways/__tests__/recording-query-builder';

/**
 * GET /organizations/:id and GET /organizations are open to every member.
 * The organization row carries `billingInfo` (Stripe customer and
 * subscription ids, the signed license token) and `settings.pendingInvites`
 * (single-use invite tokens). Neither may reach a payload.
 *
 * The PATCH path reads the row and writes it back, so it must work on the
 * stored row: stripping the payload before the save used to erase every
 * outstanding invite token on any organization edit.
 */
describe('organization payloads', () => {
  let organizations: FakeRepository<Organization>;
  let memberships: FakeRepository<any>;
  let service: OrganizationsService;

  const stored = () => ({
    id: 'org-1',
    name: 'Acme',
    slug: 'acme',
    plan: 'pro',
    billingInfo: { stripeCustomerId: 'cus_123', stripeSubscriptionId: 'sub_456', licenseToken: 'signed.license.token' },
    settings: {
      maxApis: 5,
      pendingInvites: [{ email: 'new@acme.test', role: 'member', inviteToken: 'invite-secret', inviteExpiresAt: '2099-01-01' }],
    },
    members: [],
  });

  beforeEach(() => {
    organizations = fakeRepository<Organization>({ make: () => new Organization(), seed: [stored() as any] });
    memberships = fakeRepository<any>([
      { id: 'm-1', userId: 'member-1', organizationId: 'org-1', isActive: true, organization: stored() },
    ]);
    // Counts computed from the membership table, not canned.
    (memberships as any).createQueryBuilder = () =>
      new RecordingQueryBuilder('membership', {
        getRawMany: (q: any) => {
          const ids: string[] = q.parameters.ids;
          return ids.map((id) => ({
            organizationId: id,
            count: String(memberships.rows().filter((m) => m.organizationId === id && m.isActive).length),
          }));
        },
      });
    service = new OrganizationsService(
      organizations as any,
      memberships as any,
      fakeRepository<any>() as any,
      fakeRepository<any>() as any,
      fakeRepository<any>() as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
  });

  it('GET /organizations/:id carries no billing info and no invite tokens', async () => {
    const org: any = await service.findOne('org-1');
    expect(org.name).toBe('Acme');
    expect(org.plan).toBe('pro');
    expect(org).not.toHaveProperty('billingInfo');
    expect(JSON.stringify(org)).not.toContain('invite-secret');
    expect(JSON.stringify(org)).not.toContain('cus_123');
  });

  it('GET /organizations carries no billing info and no invite tokens', async () => {
    const list: any[] = await service.findAll('member-1');
    expect(list).toHaveLength(1);
    expect(list[0].memberCount).toBe(1);
    expect(list[0]).not.toHaveProperty('billingInfo');
    const body = JSON.stringify(list);
    expect(body).not.toContain('invite-secret');
    expect(body).not.toContain('signed.license.token');
  });

  it('PATCH keeps the stored billing info and invite tokens, and returns neither', async () => {
    const result: any = await service.update('org-1', { settings: { maxApis: 9 } } as any);

    expect(result).not.toHaveProperty('billingInfo');
    expect(JSON.stringify(result)).not.toContain('invite-secret');

    const row: any = organizations.row('org-1');
    expect(row.settings.maxApis).toBe(9);
    expect(row.settings.pendingInvites[0].inviteToken).toBe('invite-secret');
    expect(row.billingInfo.licenseToken).toBe('signed.license.token');
  });
});
