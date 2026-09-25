import { HttpException } from '@nestjs/common';

import { Gateway, GatewayKind, GatewayStatus, GatewayType } from '../../../entities/gateway.entity';
import { Organization } from '../../../entities/organization.entity';
import { fakeRepository } from '../../../test/fake-repository';
import { CAST, castFixture } from '../../../test/execution-access.fixture';
import { GatewaysService } from '../gateways.service';
import { GatewaySkillsController } from '../gateway-skills.controller';

/**
 * The skills controller reads the gateway as the caller, not only behind
 * PrivateGatewayGuard.
 *
 * Every route here names a gateway by id and hands back what it publishes:
 * its skill bundle, one SKILL.md per tool, a CLI bundle, an SDK, or a run
 * of one of its tools. The guard in front of the controller refuses a
 * gateway the caller may not read, but the routes themselves asked
 * GatewaysService.getGateway with no caller (or not at all), so a route
 * that lost the guard -- a new one, a controller split, a guard list
 * edited -- served a team gateway to a member outside the team and a
 * private gateway to anyone. Each route now asks the service with the
 * caller, and gets the not-found a missing gateway gets.
 *
 * The controller is exercised with no guard at all, on purpose: this is
 * the defence behind it. Real GatewaysService.getGateway and the real
 * access policy over an in-memory membership table.
 */
describe('gateway skills routes read the gateway as the caller', () => {
  const ORG = CAST.org;
  const TEAM_GW = '0d000000-0000-4000-8000-000000000001';
  const PRIVATE_GW = '0d000000-0000-4000-8000-000000000002';
  const MISSING_GW = '0d000000-0000-4000-8000-00000000dead';
  const TOOL = '0e000000-0000-4000-8000-000000000001';

  let controller: GatewaySkillsController;
  let generated: jest.Mock;

  beforeEach(() => {
    const m = castFixture();
    const gateways = fakeRepository<Gateway>({
      make: () => new Gateway(),
      seed: [
        {
          id: TEAM_GW, organizationId: ORG, name: 'Payments Skills', type: GatewayType.SKILLS, kind: GatewayKind.TOOL,
          endpoint: '/payments-skills', status: GatewayStatus.ACTIVE, visibility: 'team', teamId: CAST.team, ownerUserId: null, tools: [],
        },
        {
          id: PRIVATE_GW, organizationId: ORG, name: 'Mine', type: GatewayType.SKILLS, kind: GatewayKind.TOOL,
          endpoint: '/mine', status: GatewayStatus.ACTIVE, visibility: 'private', teamId: null, ownerUserId: CAST.owner, tools: [],
        },
      ] as any,
    });
    const service = new GatewaysService(
      gateways as any, fakeRepository<any>([]) as any, fakeRepository<any>([]) as any, fakeRepository<any>([]) as any,
      fakeRepository<Organization>([{ id: ORG, slug: 'acme', name: 'Acme' }] as any) as any, fakeRepository<any>([]) as any,
      { log: jest.fn() } as any, undefined as any, { ensureSystemGateway: jest.fn() } as any, m.accessPolicy,
    );
    generated = jest.fn(async () => ({ generated: true }));
    controller = new GatewaySkillsController(
      service,
      {} as any,
      { generateGatewaySkills: generated, generateIndividualSkills: generated } as any,
      { executeTool: generated } as any,
      { generateGatewayCliBunde: generated } as any,
      { generateGatewaySdk: generated } as any,
    );
  });

  const as = (userId: string) => ({ user: { id: userId, sub: userId, currentOrganizationId: ORG } });
  const ROUTES: Array<[string, (c: GatewaySkillsController, gatewayId: string, req: any) => Promise<unknown>]> = [
    ['GET :gatewayId/skills', (c, id, req) => c.getGatewaySkills(id, req)],
    ['GET :gatewayId/skills/individual', (c, id, req) => c.getGatewayIndividualSkills(id, req)],
    ['POST :gatewayId/skills/:toolId/execute', (c, id, req) => c.executeSkill(id, TOOL, { parameters: {} }, req)],
    ['GET :gatewayId/cli-bundle', (c, id, req) => c.getGatewayCliBundle(id, 'bash', req)],
    ['GET :gatewayId/sdk', (c, id, req) => c.getGatewaySdk(id, req)],
  ];
  const statusOf = (p: Promise<unknown>) => p.then(() => 200, (e: HttpException) => e.getStatus());

  describe.each(ROUTES)('%s', (_route, call) => {
    it('answers a member outside the team the 404 a missing gateway gets, and generates nothing', async () => {
      expect(await statusOf(call(controller, MISSING_GW, as(CAST.member)))).toBe(404);
      expect(await statusOf(call(controller, TEAM_GW, as(CAST.nonMember)))).toBe(404);
      expect(generated).not.toHaveBeenCalled();
    });

    it('answers anyone but its owner the 404 for a private gateway, org admins included', async () => {
      expect(await statusOf(call(controller, PRIVATE_GW, as(CAST.admin)))).toBe(404);
      expect(await statusOf(call(controller, PRIVATE_GW, as(CAST.member)))).toBe(404);
      expect(generated).not.toHaveBeenCalled();
    });
  });

  it('still serves the team, and the owner of a private gateway', async () => {
    await expect(controller.getGatewaySkills(TEAM_GW, as(CAST.member))).resolves.toMatchObject({ success: true });
    await expect(controller.getGatewaySdk(TEAM_GW, as(CAST.admin))).resolves.toMatchObject({ success: true });
    await expect(controller.getGatewayCliBundle(PRIVATE_GW, 'bash', as(CAST.owner))).resolves.toMatchObject({ success: true });
  });
});
