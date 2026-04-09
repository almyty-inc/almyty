/**
 * Real-pipeline integration spec for the RBAC guard chain.
 *
 * The existing roles.guard.spec.ts passes a mock ExecutionContext
 * with inline membership data and asserts the guard's canActivate
 * returns true/false. That tests the guard in isolation but misses
 * every bug in the surrounding pipeline: a decorator not being
 * applied via Reflect metadata, JwtStrategy.validate not attaching
 * currentOrganizationId, the header-based org-switching logic, the
 * "multi-org users need explicit X-Organization-Id" fallback, the
 * interaction between JwtAuthGuard and RolesGuard in order.
 *
 * This spec builds a MINI NestJS app with one test controller, the
 * real JwtAuthGuard + RolesGuard, a real JwtStrategy (so real JWT
 * verification runs), and a mocked User repository. It then fires
 * real HTTP requests via supertest and asserts the end-to-end
 * response. If any piece of the real pipeline breaks, at least one
 * of these tests will fail with a meaningful HTTP status.
 */
jest.unmock('jsonwebtoken');

import {
  Controller,
  Get,
  Module,
  INestApplication,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { PassportModule } from '@nestjs/passport';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as request from 'supertest';

import { JwtAuthGuard } from '../../modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../modules/auth/guards/roles.guard';
import { Roles } from '../../modules/auth/decorators/roles.decorator';
import { JwtStrategy } from '../../modules/auth/strategies/jwt.strategy';
import { User } from '../../entities/user.entity';
import { OrganizationRole } from '../../entities/user-organization.entity';

const TEST_SECRET = 'rbac-integration-test-secret';

// ── Test controller — two routes, two role requirements ────────

@Controller('test-resources')
class TestController {
  @Get('admin-only')
  @Roles('admin', 'owner')
  adminOnly() {
    return { ok: true, route: 'admin-only' };
  }

  @Get('any-member')
  @Roles('viewer', 'member', 'admin', 'owner')
  anyMember() {
    return { ok: true, route: 'any-member' };
  }
}

// ── Build the mini app with the real guard pipeline ────────────

function buildUserRow(memberships: Array<{ orgId: string; role: OrganizationRole }>): any {
  return {
    id: 'user-1',
    email: 'u@example.com',
    firstName: 'U',
    lastName: 'One',
    isActive: true,
    organizationMemberships: memberships.map((m, i) => ({
      id: `mem-${i}`,
      userId: 'user-1',
      organizationId: m.orgId,
      organization: { id: m.orgId, name: `Org ${m.orgId}` },
      role: m.role,
      isActive: true,
      inviteAccepted: true,
      hasPermission: () => true,
    })),
  };
}

async function buildApp(user: any): Promise<{ app: INestApplication; jwt: JwtService }> {
  const userRepoStub = {
    findOne: jest.fn().mockResolvedValue(user),
  };

  @Module({
    imports: [
      ConfigModule.forRoot({
        load: [() => ({ JWT_SECRET: TEST_SECRET })],
        ignoreEnvFile: true,
      }),
      PassportModule.register({ defaultStrategy: 'jwt' }),
      JwtModule.register({
        secret: TEST_SECRET,
        signOptions: { expiresIn: '1h' },
      }),
    ],
    controllers: [TestController],
    providers: [
      JwtStrategy,
      Reflector,
      { provide: getRepositoryToken(User), useValue: userRepoStub },
      { provide: APP_GUARD, useClass: JwtAuthGuard },
      { provide: APP_GUARD, useClass: RolesGuard },
      ConfigService,
    ],
  })
  class TestAppModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [TestAppModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  await app.init();

  const jwt = moduleRef.get(JwtService);
  return { app, jwt };
}

function signToken(jwt: JwtService, user: any): string {
  // The JwtStrategy only reads payload.sub for the DB lookup, but
  // include the rest of the expected claims so the shape is realistic.
  return jwt.sign({
    sub: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    organizations: user.organizationMemberships.map((m: any) => ({
      id: m.organizationId,
      name: m.organization.name,
      role: m.role,
    })),
  });
}

jest.setTimeout(30_000);

describe('RBAC guard pipeline (real supertest round trip)', () => {
  // ── Owner can reach an admin-only route ────────────────────

  describe('single-org owner', () => {
    let app: INestApplication;
    let jwt: JwtService;
    let token: string;

    beforeAll(async () => {
      const user = buildUserRow([{ orgId: 'org-1', role: OrganizationRole.OWNER }]);
      ({ app, jwt } = await buildApp(user));
      token = signToken(jwt, user);
    });

    afterAll(async () => {
      await app.close();
    });

    it('200 on admin-only with owner role', async () => {
      const res = await request(app.getHttpServer())
        .get('/test-resources/admin-only')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, route: 'admin-only' });
    });

    it('200 on any-member with owner role', async () => {
      const res = await request(app.getHttpServer())
        .get('/test-resources/any-member')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    });
  });

  // ── Viewer is refused admin-only but allowed any-member ────

  describe('single-org viewer', () => {
    let app: INestApplication;
    let jwt: JwtService;
    let token: string;

    beforeAll(async () => {
      const user = buildUserRow([{ orgId: 'org-1', role: OrganizationRole.VIEWER }]);
      ({ app, jwt } = await buildApp(user));
      token = signToken(jwt, user);
    });

    afterAll(async () => {
      await app.close();
    });

    it('403 on admin-only with viewer role', async () => {
      const res = await request(app.getHttpServer())
        .get('/test-resources/admin-only')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it('200 on any-member with viewer role', async () => {
      const res = await request(app.getHttpServer())
        .get('/test-resources/any-member')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    });
  });

  // ── No token at all ─────────────────────────────────────────

  describe('no token', () => {
    let app: INestApplication;

    beforeAll(async () => {
      const user = buildUserRow([{ orgId: 'org-1', role: OrganizationRole.OWNER }]);
      ({ app } = await buildApp(user));
    });

    afterAll(async () => {
      await app.close();
    });

    it('401 when Authorization header is missing', async () => {
      const res = await request(app.getHttpServer()).get('/test-resources/admin-only');
      expect(res.status).toBe(401);
    });
  });

  // ── Garbage / tampered token ───────────────────────────────

  describe('invalid token', () => {
    let app: INestApplication;
    let jwt: JwtService;
    let validToken: string;

    beforeAll(async () => {
      const user = buildUserRow([{ orgId: 'org-1', role: OrganizationRole.OWNER }]);
      ({ app, jwt } = await buildApp(user));
      validToken = signToken(jwt, user);
    });

    afterAll(async () => {
      await app.close();
    });

    it('401 with a gibberish Bearer token', async () => {
      const res = await request(app.getHttpServer())
        .get('/test-resources/admin-only')
        .set('Authorization', 'Bearer not-a-real-jwt');
      expect(res.status).toBe(401);
    });

    it('401 with a token signed by a different secret', async () => {
      const foreignJwt = new JwtService({ secret: 'attacker-controlled-secret' });
      const forged = foreignJwt.sign({ sub: 'user-1' });

      const res = await request(app.getHttpServer())
        .get('/test-resources/admin-only')
        .set('Authorization', `Bearer ${forged}`);
      expect(res.status).toBe(401);
    });

    it('401 with a tampered signature', async () => {
      const [h, p, s] = validToken.split('.');
      const tamperedSig = s.replace(/./, (c) => (c === 'a' ? 'b' : 'a'));
      const res = await request(app.getHttpServer())
        .get('/test-resources/admin-only')
        .set('Authorization', `Bearer ${h}.${p}.${tamperedSig}`);
      expect(res.status).toBe(401);
    });
  });

  // ── Multi-org user MUST send X-Organization-Id header ──────

  describe('multi-org user', () => {
    let app: INestApplication;
    let jwt: JwtService;
    let token: string;

    beforeAll(async () => {
      const user = buildUserRow([
        { orgId: 'org-alpha', role: OrganizationRole.OWNER },
        { orgId: 'org-beta', role: OrganizationRole.VIEWER },
      ]);
      ({ app, jwt } = await buildApp(user));
      token = signToken(jwt, user);
    });

    afterAll(async () => {
      await app.close();
    });

    it('403 when no X-Organization-Id header is sent (ambiguous org)', async () => {
      // currentOrganizationId is undefined because the user has
      // multiple memberships and no header. The RolesGuard refuses
      // the request because it can't determine which org to check
      // the role against.
      const res = await request(app.getHttpServer())
        .get('/test-resources/admin-only')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it('200 on admin-only when X-Organization-Id=org-alpha (owner there)', async () => {
      const res = await request(app.getHttpServer())
        .get('/test-resources/admin-only')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Organization-Id', 'org-alpha');
      expect(res.status).toBe(200);
    });

    it('403 on admin-only when X-Organization-Id=org-beta (viewer there)', async () => {
      const res = await request(app.getHttpServer())
        .get('/test-resources/admin-only')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Organization-Id', 'org-beta');
      expect(res.status).toBe(403);
    });

    it('401 when X-Organization-Id points to an org the user is not a member of', async () => {
      const res = await request(app.getHttpServer())
        .get('/test-resources/any-member')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Organization-Id', 'org-nobody');
      expect(res.status).toBe(401);
    });
  });

  // ── Inactive user is rejected ──────────────────────────────

  describe('inactive user', () => {
    let app: INestApplication;
    let jwt: JwtService;
    let token: string;

    beforeAll(async () => {
      const user = buildUserRow([{ orgId: 'org-1', role: OrganizationRole.OWNER }]);
      user.isActive = false;
      ({ app, jwt } = await buildApp(user));
      token = signToken(jwt, user);
    });

    afterAll(async () => {
      await app.close();
    });

    it('401 when the user row is isActive=false', async () => {
      const res = await request(app.getHttpServer())
        .get('/test-resources/any-member')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
    });
  });
});
