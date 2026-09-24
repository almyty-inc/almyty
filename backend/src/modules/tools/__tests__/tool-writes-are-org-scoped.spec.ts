import { BadRequestException, NotFoundException } from '@nestjs/common';

import { ToolsService } from '../tools.service';
import { Organization } from '../../../entities/organization.entity';
import { User } from '../../../entities/user.entity';
import { Tool } from '../../../entities/tool.entity';
import { fakeManager, fakeRepository, FakeRepository } from '../../../test/fake-repository';

/**
 * Writes to a tool are scoped to the caller's organization. In
 * `tools.service.spec.ts` the tool double is `findOne: jest.fn()` resolving
 * a canned row, and the api repository has no `findOne` at all, so neither
 * the `organizationId` in `updateTool`'s lookup nor the one in
 * `createTool`'s api check was ever evaluated. Here the tables are real.
 */
describe('ToolsService writes are organization-scoped', () => {
  const ORG = 'org-1';
  const OTHER_ORG = 'org-2';
  const USER = 'user-1';

  let service: ToolsService;
  let tools: FakeRepository<any>;

  beforeEach(() => {
    tools = fakeRepository<any>({
      seed: [
        { id: 'tool-theirs', name: 'Theirs', organizationId: OTHER_ORG, createdBy: USER, version: '1.0.0', visibility: 'org' },
        { id: 'tool-mine', name: 'Mine', organizationId: ORG, createdBy: USER, version: '1.0.0', visibility: 'org' },
      ],
    });
    const apis = fakeRepository<any>([
      { id: 'api-theirs', organizationId: OTHER_ORG, visibility: 'org' },
      { id: 'api-mine', organizationId: ORG, visibility: 'org' },
    ]);
    const organizations = fakeRepository<any>({ make: () => new Organization(), seed: [{ id: ORG, settings: {} }] });
    // The tool quota counts through `toolRepository.manager`.
    fakeManager([
      [Tool, tools],
      [Organization, organizations],
    ]);
    const users = fakeRepository<any>({
      make: () => new User(),
      seed: [
        {
          id: USER,
          organizationMemberships: [
            { organizationId: ORG, role: 'owner', isActive: true, inviteAccepted: true },
          ] as any,
        },
      ],
    });
    const accessPolicy = {
      canAccess: jest.fn().mockResolvedValue({ allowed: true, reason: 'ok' }),
      assertCanScopeToTeam: jest.fn().mockResolvedValue(undefined),
    };
    const audit = {
      logCreate: jest.fn(),
      logUpdate: jest.fn(),
      computeChanges: jest.fn().mockReturnValue([]),
    };

    service = new ToolsService(
      tools as any,
      fakeRepository<any>() as any,
      fakeRepository<any>() as any,
      fakeRepository<any>() as any,
      apis as any,
      fakeRepository<any>() as any,
      fakeRepository<any>() as any,
      users as any,
      organizations as any,
      audit as any,
      {} as any,
      {} as any,
      accessPolicy as any,
    );
  });

  describe('updateTool', () => {
    it("edits the caller's organization's tool", async () => {
      await service.updateTool('tool-mine', { name: 'Renamed' } as any, ORG, USER);

      expect(tools.row('tool-mine')!.name).toBe('Renamed');
    });

    it("does not reach another organization's tool", async () => {
      await expect(
        service.updateTool('tool-theirs', { name: 'pwned' } as any, ORG, USER),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(tools.row('tool-theirs')!.name).toBe('Theirs');
    });
  });

  describe('createTool', () => {
    it("binds an API of the caller's organization", async () => {
      const created = await service.createTool({ name: 'ok', apiId: 'api-mine' } as any, ORG, USER);

      expect(tools.row(created.id)!.apiId).toBe('api-mine');
    });

    it("refuses to bind another organization's API", async () => {
      await expect(
        service.createTool({ name: 'borrowed', apiId: 'api-theirs' } as any, ORG, USER),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(tools.rows().map((t) => t.name)).not.toContain('borrowed');
    });
  });
});
