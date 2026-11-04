import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';

import { TeamRole } from '../../../entities/user-team.entity';
import { AddTeamMemberDto, UpdateTeamMemberRoleDto } from '../dto/team-member.dto';
import { OrganizationsController } from '../organizations.controller';
import { OrganizationsService } from '../organizations.service';

/**
 * "Role in team" when a member is added to a team: the role the person
 * picked reaches the membership row. It used to be dropped at the
 * controller, so everyone added came in as a plain member.
 */
describe('adding a team member keeps the role in team', () => {
  const ORG = '6f1c1d2e-7a0b-4c8e-9d3f-1a2b3c4d5e6f';
  const TEAM = '0e9d8c7b-6a5f-4e3d-8c2b-1a0f9e8d7c6b';
  const USER = '3b2a1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d';

  // The global pipe, as main.ts sets it up.
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: false } });
  const body = (metatype: any): ArgumentMetadata => ({ type: 'body', metatype, data: '' });

  describe('validation', () => {
    it.each([TeamRole.MEMBER, TeamRole.LEAD])('takes role %s', async (role) => {
      await expect(pipe.transform({ userId: USER, role }, body(AddTeamMemberDto))).resolves.toEqual({ userId: USER, role });
    });

    it('leaves the role out when none is sent', async () => {
      await expect(pipe.transform({ userId: USER }, body(AddTeamMemberDto))).resolves.toEqual({ userId: USER });
    });

    it.each([['an org role', { userId: USER, role: 'admin' }], ['no user', { role: 'lead' }], ['a user that is not an id', { userId: 'bob', role: 'lead' }], ['an unknown field', { userId: USER, role: 'lead', owner: true }]])(
      'refuses %s',
      async (_what, payload) => {
        await expect(pipe.transform(payload, body(AddTeamMemberDto))).rejects.toBeInstanceOf(BadRequestException);
      },
    );

    it('a role change takes member or lead only', async () => {
      await expect(pipe.transform({ role: 'lead' }, body(UpdateTeamMemberRoleDto))).resolves.toEqual({ role: 'lead' });
      await expect(pipe.transform({ role: 'owner' }, body(UpdateTeamMemberRoleDto))).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('controller', () => {
    const setup = () => {
      const service = { addTeamMember: jest.fn().mockResolvedValue(undefined) };
      const audit = { log: jest.fn().mockResolvedValue(undefined) };
      const controller = new OrganizationsController(service as unknown as OrganizationsService, audit as any);
      return { service, audit, controller };
    };

    it('the route body is the validated DTO', () => {
      const types = Reflect.getMetadata('design:paramtypes', OrganizationsController.prototype, 'addMemberToTeam');
      expect(types[2]).toBe(AddTeamMemberDto);
      expect(Reflect.getMetadata('design:paramtypes', OrganizationsController.prototype, 'updateTeamMemberRole')[3]).toBe(UpdateTeamMemberRoleDto);
    });

    it('passes the chosen role to the service', async () => {
      const { service, controller } = setup();
      await controller.addMemberToTeam(ORG, TEAM, { userId: USER, role: TeamRole.LEAD }, { user: { id: 'admin-1' } });
      expect(service.addTeamMember).toHaveBeenCalledWith(ORG, TEAM, USER, TeamRole.LEAD, 'admin-1');
    });

    it('a member when no role is sent', async () => {
      const { service, controller } = setup();
      await controller.addMemberToTeam(ORG, TEAM, { userId: USER }, { user: { id: 'admin-1' } });
      expect(service.addTeamMember).toHaveBeenCalledWith(ORG, TEAM, USER, TeamRole.MEMBER, 'admin-1');
    });
  });

  describe('service', () => {
    const setup = () => {
      const userTeams = {
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn((row) => row),
        save: jest.fn(async (row) => row),
      };
      const service: any = Object.create(OrganizationsService.prototype);
      service.teamRepository = { findOne: jest.fn().mockResolvedValue({ id: TEAM, organizationId: ORG }) };
      service.userOrganizationRepository = { findOne: jest.fn().mockResolvedValue({ userId: USER, organizationId: ORG, isActive: true }) };
      service.userTeamRepository = userTeams;
      return { service: service as OrganizationsService, userTeams };
    };

    it('writes the role it is given on the membership', async () => {
      const { service, userTeams } = setup();
      await service.addTeamMember(ORG, TEAM, USER, TeamRole.LEAD);
      expect(userTeams.save).toHaveBeenCalledWith({ teamId: TEAM, userId: USER, role: TeamRole.LEAD });
    });

    it('refuses a role that is not a team role, and writes nothing', async () => {
      const { service, userTeams } = setup();
      await expect(service.addTeamMember(ORG, TEAM, USER, 'owner' as TeamRole)).rejects.toBeInstanceOf(BadRequestException);
      expect(userTeams.save).not.toHaveBeenCalled();
    });
  });
});
