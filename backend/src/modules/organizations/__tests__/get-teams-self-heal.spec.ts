import { Test, TestingModule } from '@nestjs/testing'
import { getRepositoryToken } from '@nestjs/typeorm'

import { OrganizationsService } from '../organizations.service'
import { OrganizationsInvitesHelper } from '../organizations-invites.helper'
import { TeamMembershipHelper } from '../team-membership.helper'
import { Organization } from '../../../entities/organization.entity'
import { User } from '../../../entities/user.entity'
import { UserOrganization, OrganizationRole } from '../../../entities/user-organization.entity'
import { Team } from '../../../entities/team.entity'
import { UserTeam } from '../../../entities/user-team.entity'
import { MailService } from '../../mail/mail.service'
import { GatewaysService } from '../../gateways/gateways.service'

// Regression for #101. Orgs created in the migration gap (or via
// code paths that skipped joinDefaultTeam) had no default team.
// getTeams() now self-heals by counting default teams first and
// joining every active OWNER as LEAD when the count is zero.

describe('OrganizationsService.getTeams self-heal (#101)', () => {
  let service: OrganizationsService
  let teamRepository: any
  let userOrganizationRepository: any
  let teamMembershipHelper: { joinDefaultTeam: jest.Mock }

  beforeEach(async () => {
    teamMembershipHelper = { joinDefaultTeam: jest.fn().mockResolvedValue(undefined) }
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrganizationsService,
        OrganizationsInvitesHelper,
        { provide: TeamMembershipHelper, useValue: teamMembershipHelper },
        { provide: getRepositoryToken(Organization), useValue: { findOne: jest.fn(), find: jest.fn(), create: jest.fn(), save: jest.fn() } },
        { provide: getRepositoryToken(User), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(UserOrganization), useValue: { findOne: jest.fn(), find: jest.fn() } },
        { provide: getRepositoryToken(Team), useValue: { find: jest.fn(), count: jest.fn() } },
        { provide: getRepositoryToken(UserTeam), useValue: { find: jest.fn() } },
        { provide: MailService, useValue: { send: jest.fn(), sendInvitation: jest.fn() } },
        { provide: GatewaysService, useValue: { ensureSystemGateway: jest.fn() } },
      ],
    }).compile()

    service = module.get(OrganizationsService)
    teamRepository = module.get(getRepositoryToken(Team))
    userOrganizationRepository = module.get(getRepositoryToken(UserOrganization))
  })

  it('skips the self-heal write path when a default team already exists', async () => {
    teamRepository.count.mockResolvedValue(1)
    teamRepository.find.mockResolvedValue([{ id: 't1', isDefault: true }])

    await service.getTeams('org-1')

    expect(teamMembershipHelper.joinDefaultTeam).not.toHaveBeenCalled()
    expect(userOrganizationRepository.find).not.toHaveBeenCalled()
  })

  it('joins every active OWNER as LEAD when no default team exists', async () => {
    teamRepository.count.mockResolvedValue(0)
    userOrganizationRepository.find.mockResolvedValue([
      { userId: 'u-owner-1', role: OrganizationRole.OWNER, isActive: true },
      { userId: 'u-owner-2', role: OrganizationRole.OWNER, isActive: true },
    ])
    teamRepository.find.mockResolvedValue([{ id: 't-new', isDefault: true }])

    const result = await service.getTeams('org-2')

    expect(teamMembershipHelper.joinDefaultTeam).toHaveBeenCalledTimes(2)
    expect(teamMembershipHelper.joinDefaultTeam).toHaveBeenCalledWith('org-2', 'u-owner-1', OrganizationRole.OWNER)
    expect(teamMembershipHelper.joinDefaultTeam).toHaveBeenCalledWith('org-2', 'u-owner-2', OrganizationRole.OWNER)
    expect(result).toEqual([{ id: 't-new', isDefault: true }])
  })
})
