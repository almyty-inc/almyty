import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { Organization } from '../../../entities/organization.entity';
import { User } from '../../../entities/user.entity';
import { UserOrganization } from '../../../entities/user-organization.entity';
import { Team } from '../../../entities/team.entity';
import { UserTeam } from '../../../entities/user-team.entity';
import { MailService } from '../../mail/mail.service';
import { GatewaysService } from '../../gateways/gateways.service';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { ResourceHandoverHelper } from '../resource-handover.helper';
import { OrganizationsService } from '../organizations.service';
import { OrganizationsInvitesHelper } from '../organizations-invites.helper';
import { TeamMembershipHelper } from '../team-membership.helper';

/**
 * The organization list prints "N members" per row and the detail header
 * repeats the number. findAll never loaded the members relation, so the
 * page read `org.members?.length` off an undefined relation and every
 * organization reported zero -- next to a Members tab listing five people.
 */
describe('OrganizationsService.findAll — member counts', () => {
  let service: OrganizationsService;
  let userOrganizationRepository: any;
  let rawCounts: Array<{ organizationId: string; count: string }>;

  beforeEach(async () => {
    rawCounts = [
      { organizationId: 'org-a', count: '5' },
      { organizationId: 'org-b', count: '1' },
    ];

    userOrganizationRepository = {
      find: jest.fn().mockResolvedValue([
        { organization: { id: 'org-a', name: 'Alpha' } },
        { organization: { id: 'org-b', name: 'Beta' } },
      ]),
      createQueryBuilder: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue(rawCounts),
      })),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrganizationsService,
        { provide: getRepositoryToken(Organization), useValue: {} },
        { provide: getRepositoryToken(UserOrganization), useValue: userOrganizationRepository },
        { provide: getRepositoryToken(Team), useValue: {} },
        { provide: getRepositoryToken(UserTeam), useValue: {} },
        { provide: getRepositoryToken(User), useValue: {} },
        { provide: MailService, useValue: {} },
        { provide: GatewaysService, useValue: {} },
        { provide: OrganizationsInvitesHelper, useValue: {} },
        { provide: TeamMembershipHelper, useValue: {} },
        { provide: ResourceHandoverHelper, useValue: {} },
        { provide: AuditLogService, useValue: {} },
      ],
    }).compile();

    service = module.get(OrganizationsService);
  });

  it('reports how many members each organization actually has', async () => {
    const organizations = await service.findAll('user-1');

    expect(organizations.map((o: any) => [o.id, o.memberCount])).toEqual([
      ['org-a', 5],
      ['org-b', 1],
    ]);
  });

  it('says zero rather than undefined when an organization has no counted rows', async () => {
    rawCounts = [{ organizationId: 'org-a', count: '5' }];

    const organizations = await service.findAll('user-1');

    expect((organizations[1] as any).memberCount).toBe(0);
  });

  it('does not run a count query when the user belongs to nothing', async () => {
    userOrganizationRepository.find.mockResolvedValue([]);

    await expect(service.findAll('user-1')).resolves.toEqual([]);
    expect(userOrganizationRepository.createQueryBuilder).not.toHaveBeenCalled();
  });
});
