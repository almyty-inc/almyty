import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AgentRole } from '../../../entities/agent-role.entity';
import { AgentRolesController } from '../agent-roles.controller';
import { AgentRolesService, RoleUnresolvedError } from '../agent-roles.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

/**
 * Resolving a role that cannot be filled.
 *
 * Found on staging, not here: a brand new organization with no models is
 * the COMMON case for this endpoint, and it answered "Internal server
 * error". That reads as our fault when the fix is the caller's and is one
 * step, and it is the first thing a new user does after making a role.
 *
 * The service threw a typed error all along. Nothing translated it.
 */
describe('POST /agents/:id/roles/resolve when a role cannot be filled', () => {
  let app: INestApplication;
  const rolesService = { resolveRoles: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AgentRolesController],
      providers: [
        { provide: AgentRolesService, useValue: rolesService },
        { provide: getRepositoryToken(AgentRole), useValue: {} },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: any) => {
          ctx.switchToHttp().getRequest().user = { currentOrganizationId: 'org-1', id: 'u1' };
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => await app?.close());
  beforeEach(() => jest.clearAllMocks());

  const id = '3f1b6a24-6c1e-4f77-9a1a-0f2f0a1d9c11';
  const post = () => request(app.getHttpServer()).post(`/agents/${id}/roles/resolve`).send({});

  it('says which role and what to do, instead of a generic 500', async () => {
    rolesService.resolveRoles.mockRejectedValue(new RoleUnresolvedError('principal', 'no model in the catalog is usable'));

    const { body } = await post().expect(409);
    expect(body.code).toBe('ROLE_UNRESOLVED');
    expect(body.message).toContain('principal');
    expect(body.message).toMatch(/add a model|pin this role/i);
  });

  it('translates a routing failure the same way', async () => {
    rolesService.resolveRoles.mockRejectedValue(Object.assign(new Error('no candidate passed the policy'), { code: 'NO_ROUTE' }));

    const { body } = await post().expect(409);
    expect(body.code).toBe('NO_ROUTE');
    expect(body.message).toMatch(/no model in the catalog/i);
  });

  it('still lets a genuine fault be a 500 rather than dressing it up', async () => {
    // A database outage is our problem, and reporting it as a caller
    // error would send someone editing roles to fix an outage.
    rolesService.resolveRoles.mockRejectedValue(new Error('connection terminated unexpectedly'));
    await post().expect(500);
  });

  it('answers normally when every role resolves', async () => {
    rolesService.resolveRoles.mockResolvedValue([{ key: 'principal', modelId: 'm1', via: 'resolved' }]);

    const { body } = await post().expect(201);
    expect(body.data[0].key).toBe('principal');
  });
});
