/**
 * Real-HTTP integration test for MCP OAuth 2.1 + MCP tool listing.
 *
 * Uses TestAppModule (no BullMQ/Redis — won't hang) with a real Postgres.
 * Gated behind RUN_DB_INTEGRATION=1.
 *
 * Tests the actual bugs we hit in production:
 *   1. OAuth discovery at RFC 8414 path with non-UUID org slug
 *   2. OAuth client registration
 *   3. Authorize endpoint redirects to /auth/login (not /login)
 *   4. Authorize endpoint recognizes JWT cookie after login
 *   5. System gateway routes to AlmytyMcpService (returns tools)
 *   6. prompts/get, resources/list return valid (not error) responses
 */
import * as crypto from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as cookieParser from 'cookie-parser';
import { DataSource } from 'typeorm';

import { TestAppModule } from '../test-app.module';
import { Organization } from '../../entities/organization.entity';
import { User } from '../../entities/user.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { Gateway, GatewayType, GatewayKind, GatewayStatus } from '../../entities/gateway.entity';
import { GatewayAuth, GatewayAuthType } from '../../entities/gateway-auth.entity';
import { AuthService } from '../../modules/auth/auth.service';

const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;

describeIfDb('MCP OAuth + tools (real HTTP)', () => {
  let app: INestApplication;
  let ds: DataSource;

  const ORG_SLUG = `mcp-test-${Date.now()}`;
  const TEST_EMAIL = `mcp-test-${Date.now()}@test.com`;
  const TEST_PASSWORD = 'TestPass123!';

  let org: Organization;
  let user: any;
  let gateway: Gateway;
  let accessTokenCookie: string;
  let bearerToken: string;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [TestAppModule],
    }).compile();

    app = module.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    ds = module.get(DataSource);
    const authService = module.get(AuthService);

    // Seed org
    const orgRepo = ds.getRepository(Organization);
    org = orgRepo.create({ name: `MCP Test ${Date.now()}`, slug: ORG_SLUG });
    org = await orgRepo.save(org);

    // Seed user via AuthService (hashes password properly)
    const tokens = await authService.register({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      firstName: 'MCP',
      lastName: 'Test',
      organizationName: `ignore-${Date.now()}`,
    });
    // Get the user from DB since register only returns tokens
    const userRepo = ds.getRepository(User);
    user = await userRepo.findOne({ where: { email: TEST_EMAIL } });

    // Link user to our org
    const uoRepo = ds.getRepository(UserOrganization);
    await uoRepo.save(uoRepo.create({
      userId: user.id,
      organizationId: org.id,
      role: OrganizationRole.OWNER,
    }));

    // Create system gateway
    const gwRepo = ds.getRepository(Gateway);
    gateway = gwRepo.create({
      name: 'almyty',
      endpoint: '/almyty',
      type: GatewayType.MCP,
      kind: GatewayKind.TOOL,
      status: GatewayStatus.ACTIVE,
      organizationId: org.id,
      isSystem: true,
      configuration: { transport: 'http' },
    });
    gateway = await gwRepo.save(gateway);

    // Create OAuth auth config for the gateway
    const gwAuthRepo = ds.getRepository(GatewayAuth);
    await gwAuthRepo.save(gwAuthRepo.create({
      gatewayId: gateway.id,
      type: GatewayAuthType.OAUTH2,
      isRequired: true,
      isActive: true,
      configuration: {},
      validationRules: {},
      errorResponses: {},
    }));

    // Login to get JWT cookie
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD })
      .expect(200);

    const setCookie = loginRes.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    accessTokenCookie = cookieStr?.split(';')[0] || '';
    // Extract raw JWT for Bearer auth on MCP endpoints
    bearerToken = accessTokenCookie.replace('access_token=', '');
  }, 30000);

  afterAll(async () => {
    // Cleanup
    if (ds?.isInitialized) {
      try {
        await ds.getRepository(GatewayAuth).delete({ gatewayId: gateway?.id });
        await ds.getRepository(Gateway).delete({ id: gateway?.id });
        await ds.getRepository(UserOrganization).delete({ userId: user?.id });
        await ds.getRepository(User).delete({ id: user?.id });
        await ds.getRepository(Organization).delete({ id: org?.id });
      } catch {}
    }
    if (app) await app.close();
  }, 15000);

  // --- Bug #1: RFC 8414 OAuth discovery with non-UUID org slug ---
  describe('OAuth discovery', () => {
    it('returns metadata at RFC 8414 path (non-UUID slug)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/.well-known/oauth-authorization-server/mcp/${ORG_SLUG}/almyty`)
        .expect(200);

      expect(res.body.issuer).toContain(`/mcp/${ORG_SLUG}/almyty`);
      expect(res.body.registration_endpoint).toContain('/register');
      expect(res.body.authorization_endpoint).toContain('/authorize');
      expect(res.body.token_endpoint).toContain('/token');
    });

    it('returns protected resource metadata', async () => {
      const res = await request(app.getHttpServer())
        .get(`/.well-known/oauth-protected-resource/mcp/${ORG_SLUG}/almyty`)
        .expect(200);

      expect(res.body.resource).toContain(`/mcp/${ORG_SLUG}/almyty`);
      expect(res.body.authorization_servers).toHaveLength(1);
    });

    it('returns 404 for non-existent org', async () => {
      await request(app.getHttpServer())
        .get('/.well-known/oauth-authorization-server/mcp/nonexistent-org/almyty')
        .expect(404);
    });
  });

  // --- Bug #2: OAuth client registration ---
  describe('OAuth registration', () => {
    it('registers a client successfully', async () => {
      const res = await request(app.getHttpServer())
        .post(`/mcp/${ORG_SLUG}/almyty/register`)
        .send({
          client_name: 'test-client',
          redirect_uris: ['http://localhost:3000/callback'],
          token_endpoint_auth_method: 'none',
        })
        .expect(201);

      expect(res.body.client_id).toBeDefined();
      expect(res.body.client_name).toBe('test-client');
    });

    it('rejects registration without client_name', async () => {
      await request(app.getHttpServer())
        .post(`/mcp/${ORG_SLUG}/almyty/register`)
        .send({ redirect_uris: ['http://localhost/cb'] })
        .expect(400);
    });
  });

  // --- Bug #3: Authorize redirects to /auth/login (not /login) ---
  describe('OAuth authorize', () => {
    it('redirects unauthenticated users to /auth/login', async () => {
      const res = await request(app.getHttpServer())
        .get(`/mcp/${ORG_SLUG}/almyty/authorize`)
        .query({
          response_type: 'code',
          client_id: 'test',
          redirect_uri: 'http://localhost/cb',
          code_challenge: 'test',
          code_challenge_method: 'S256',
        })
        .expect(302);

      expect(res.headers.location).toContain('/auth/login');
      // Must be /auth/login, not bare /login (the bug we fixed)
      expect(res.headers.location).not.toMatch(/\/login\?(?!.*\/auth\/)/);
      expect(res.headers.location).toMatch(/\/auth\/login\?/);
    });

    it('issues auth code when user has JWT cookie', async () => {
      // First register a real client
      const regRes = await request(app.getHttpServer())
        .post(`/mcp/${ORG_SLUG}/almyty/register`)
        .send({
          client_name: 'auth-test',
          redirect_uris: ['http://localhost:9999/callback'],
          token_endpoint_auth_method: 'none',
        })
        .expect(201);

      const clientId = regRes.body.client_id;
      const codeVerifier = crypto.randomBytes(32).toString('base64url');
      const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

      const res = await request(app.getHttpServer())
        .get(`/mcp/${ORG_SLUG}/almyty/authorize`)
        .set('Cookie', accessTokenCookie)
        .query({
          response_type: 'code',
          client_id: clientId,
          redirect_uri: 'http://localhost:9999/callback',
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          state: 'test-state',
        })
        .expect(302);

      // Should redirect to callback with code
      expect(res.headers.location).toContain('http://localhost:9999/callback');
      expect(res.headers.location).toContain('code=');
      expect(res.headers.location).toContain('state=test-state');
    });
  });

  // --- Bug #4: System gateway returns tools via AlmytyMcpService ---
  describe('MCP tools via system gateway', () => {
    it('tools/list returns almyty management tools', async () => {
      const res = await request(app.getHttpServer())
        .post(`/mcp/${ORG_SLUG}/almyty`)
        .set('Authorization', `Bearer ${bearerToken}`)
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
        .expect(200);

      expect(res.body.result.tools).toBeDefined();
      expect(res.body.result.tools.length).toBeGreaterThan(0);
      const names = res.body.result.tools.map((t: any) => t.name);
      expect(names).toContain('list_apis');
      expect(names).toContain('list_tools');
      expect(names).toContain('list_agents');
    });

    it('initialize returns server info', async () => {
      const res = await request(app.getHttpServer())
        .post(`/mcp/${ORG_SLUG}/almyty`)
        .set('Authorization', `Bearer ${bearerToken}`)
        .send({
          jsonrpc: '2.0', id: 1, method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
        })
        .expect(200);

      expect(res.body.result.serverInfo.name).toBe('almyty');
      expect(res.body.result.capabilities.tools).toBeDefined();
    });
  });

  // --- Bug #5: prompts/get and resources/list return valid responses ---
  describe('MCP auxiliary methods', () => {
    it('prompts/list returns empty array', async () => {
      const res = await request(app.getHttpServer())
        .post(`/mcp/${ORG_SLUG}/almyty`)
        .set('Authorization', `Bearer ${bearerToken}`)
        .send({ jsonrpc: '2.0', id: 1, method: 'prompts/list', params: {} })
        .expect(200);

      expect(res.body.result.prompts).toEqual([]);
    });

    it('prompts/get returns valid message (not error)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/mcp/${ORG_SLUG}/almyty`)
        .set('Authorization', `Bearer ${bearerToken}`)
        .send({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'test' } })
        .expect(200);

      expect(res.body.result.messages).toBeDefined();
      expect(res.body.error).toBeUndefined();
    });

    it('resources/list returns empty array', async () => {
      const res = await request(app.getHttpServer())
        .post(`/mcp/${ORG_SLUG}/almyty`)
        .set('Authorization', `Bearer ${bearerToken}`)
        .send({ jsonrpc: '2.0', id: 1, method: 'resources/list', params: {} })
        .expect(200);

      expect(res.body.result.resources).toEqual([]);
    });

    it('unknown method returns -32601', async () => {
      const res = await request(app.getHttpServer())
        .post(`/mcp/${ORG_SLUG}/almyty`)
        .set('Authorization', `Bearer ${bearerToken}`)
        .send({ jsonrpc: '2.0', id: 1, method: 'bogus/method', params: {} })
        .expect(200);

      expect(res.body.error.code).toBe(-32601);
    });
  });
});
