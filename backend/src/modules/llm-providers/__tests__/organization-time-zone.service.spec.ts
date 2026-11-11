import { OrganizationTimeZoneService } from '../organization-time-zone.service';

/** The organization's time zone: its own setting, else its owner's profile, else UTC. */
describe('OrganizationTimeZoneService', () => {
  const build = (settings: Record<string, any> | null, ownerZone: string | null) => {
    const organizations = { findOne: jest.fn(async () => (settings ? { id: 'org-1', settings } : null)) };
    const qb: any = {
      innerJoin: jest.fn(() => qb),
      where: jest.fn(() => qb),
      orderBy: jest.fn(() => qb),
      select: jest.fn(() => qb),
      getOne: jest.fn(async () => (ownerZone ? { id: 'u1', timezone: ownerZone } : null)),
    };
    const users = { createQueryBuilder: jest.fn(() => qb) };
    return { service: new OrganizationTimeZoneService(organizations as any, users as any), organizations, users, qb };
  };

  it('is the one set on the organization', async () => {
    const { service, users } = build({ timezone: 'Asia/Tokyo' }, 'Europe/Berlin');
    expect(await service.zoneOf('org-1')).toBe('Asia/Tokyo');
    expect(users.createQueryBuilder).not.toHaveBeenCalled();
  });

  it("else the owner's profile time zone", async () => {
    const { service, qb } = build({}, 'Europe/Berlin');
    expect(await service.zoneOf('org-1')).toBe('Europe/Berlin');
    expect(qb.innerJoin).toHaveBeenCalledWith('u.organizationMemberships', 'm', expect.stringContaining('m.role = :role'), {
      organizationId: 'org-1',
      role: 'owner',
    });
  });

  it('else UTC, and "none" to a caller that has a fallback of its own', async () => {
    const { service } = build({ timezone: 'Not/AZone' }, null);
    expect(await service.zoneOf('org-1')).toBe('UTC');
    expect(await service.configuredZoneOf('org-1')).toBeNull();
    expect(await service.zoneOf(undefined)).toBe('UTC');
  });

  it('is read once and remembered', async () => {
    const { service, organizations } = build({ timezone: 'Asia/Tokyo' }, null);
    await service.zoneOf('org-1');
    await service.zoneOf('org-1');
    expect(organizations.findOne).toHaveBeenCalledTimes(1);
  });

  it('reads as UTC when the database cannot answer', async () => {
    const { service, organizations } = build(null, null);
    organizations.findOne.mockRejectedValueOnce(new Error('down'));
    expect(await service.zoneOf('org-2')).toBe('UTC');
  });
});
