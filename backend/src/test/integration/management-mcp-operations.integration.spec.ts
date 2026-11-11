/**
 * Integration test: the management MCP's operations against Postgres.
 *
 * The management MCP (`/:org/almyty`) runs a platform route for an MCP
 * caller by calling the route's own controller handler with its own
 * guards (management/route-invoker.service.ts). Here the route is the real
 * OrganizationsController with the real OrganizationsService over a real
 * database: a team made through `call_write_operation` is a row, a viewer
 * is refused what RolesGuard refuses them over HTTP, someone from another
 * organization is refused before any guard, and the audit trail records
 * the change with the MCP as its user agent. A curated tool
 * (list_org_members) answers to the same route guards.
 *
 * Requires: RUN_DB_INTEGRATION=1 and a running PostgreSQL.
 */

const SKIP = !process.env.RUN_DB_INTEGRATION;

import * as crypto from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { TestAppModule } from '../test-app.module';
import { Organization } from '../../entities/organization.entity';
import { User } from '../../entities/user.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { Team } from '../../entities/team.entity';
import { AuditAction } from '../../entities/audit-log.entity';
import { AuthService } from '../../modules/auth/auth.service';
import { AuditLogService } from '../../modules/audit-log/audit-log.service';
import { AlmytyMcpService } from '../../modules/mcp/almyty-mcp.service';
import { useIsolatedSchema, ensureSchema } from './isolated-schema.helper';

const SCHEMA = 'management_mcp_ops_test';
if (!SKIP) useIsolatedSchema(SCHEMA);

(SKIP ? describe.skip : describe)('Management MCP operations (integration)', () => {
  let module: TestingModule;
  let ds: DataSource;
  let mcp: AlmytyMcpService;
  let org: Organization;
  const users: Record<'owner' | 'viewer' | 'member' | 'outsider', string> = {} as any;
  const audit = {
    log: jest.fn(async () => undefined),
    logCreate: () => undefined,
    logUpdate: () => undefined,
    logDelete: () => undefined,
    logInTransaction: async () => ({}),
    publishCommitted: () => undefined,
  };

  const SUFFIX = `${Date.now()}${crypto.randomBytes(6).toString('hex')}`;

  beforeAll(async () => {
    useIsolatedSchema(SCHEMA);
    await ensureSchema(SCHEMA);
    module = await Test.createTestingModule({
      imports: [TestAppModule],
    })
      .overrideProvider(AuditLogService)
      .useValue(audit)
      .compile();
    await module.init();
    ds = module.get(DataSource);
    mcp = module.get(AlmytyMcpService);
    const auth = module.get(AuthService);

    org = await ds.getRepository(Organization).save(
      ds.getRepository(Organization).create({ name: `Mgmt MCP ${SUFFIX}`, slug: `mgmt-mcp-${SUFFIX}` }),
    );
    const roles: Array<[keyof typeof users, OrganizationRole | null]> = [
      ['owner', OrganizationRole.OWNER],
      ['member', OrganizationRole.MEMBER],
      ['viewer', OrganizationRole.VIEWER],
      ['outsider', null],
    ];
    for (const [key, role] of roles) {
      const email = `mgmt-${key}-${SUFFIX}@test.com`;
      await auth.register({
        email,
        password: 'TestPass123!',
        firstName: key,
        lastName: 'User',
        organizationName: `mgmt-${key}-own-${SUFFIX}`,
      });
      const user = await ds.getRepository(User).findOneOrFail({ where: { email } });
      users[key] = user.id;
      if (role) {
        await ds.getRepository(UserOrganization).save(
          ds.getRepository(UserOrganization).create({ userId: user.id, organizationId: org.id, role }),
        );
      }
    }
  }, 120_000);

  afterAll(async () => {
    await module?.close();
  });

  const rpc = async (who: keyof typeof users, name: string, args: any = {}) => {
    const res: any = await mcp.handleJsonRpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      org.id,
      users[who],
    );
    const text: string = res.result.content[0].text;
    return { isError: !!res.result.isError, text, json: res.result.isError ? null : JSON.parse(text) };
  };

  it('finds the team operations', async () => {
    const { json } = await rpc('viewer', 'search_operations', { resource: 'teams' });
    expect(json.operations.map((o: any) => o.name)).toEqual(
      expect.arrayContaining(['teams.list', 'teams.create', 'teams.delete']),
    );
    const detail = (await rpc('viewer', 'get_operation', { name: 'teams.create' })).json;
    expect(detail.requires.roles).toEqual(['admin', 'owner']);
    expect(detail.inputSchema.properties.body.required).toContain('name');
  });

  it('creates a team as the owner: a row, and an audit entry naming the MCP', async () => {
    const res = await rpc('owner', 'call_write_operation', {
      name: 'teams.create',
      arguments: { body: { name: `Ops ${SUFFIX}`, description: 'made over MCP' } },
    });
    expect(res.isError).toBe(false);
    const row = await ds.getRepository(Team).findOne({ where: { organizationId: org.id, name: `Ops ${SUFFIX}` } });
    expect(row).toBeTruthy();
    expect(res.json.data.id).toBe(row!.id);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: org.id,
        userId: users.owner,
        action: AuditAction.TEAM_CREATE,
        resourceId: row!.id,
        userAgent: 'almyty-mcp',
      }),
    );
  });

  it('refuses a member what the route refuses a member, and writes nothing', async () => {
    const res = await rpc('member', 'call_write_operation', { name: 'teams.create', arguments: { body: { name: `Nope ${SUFFIX}` } } });
    expect(res.text).toMatch(/Insufficient role privileges/);
    expect(await ds.getRepository(Team).count({ where: { organizationId: org.id, name: `Nope ${SUFFIX}` } })).toBe(0);
  });

  it('refuses a viewer the member-only listing, and lets a member read it', async () => {
    expect((await rpc('viewer', 'call_read_operation', { name: 'teams.list' })).text).toMatch(/Insufficient role privileges/);
    const { json } = await rpc('member', 'call_read_operation', { name: 'teams.list' });
    expect(json.data.map((t: any) => t.name)).toContain(`Ops ${SUFFIX}`);
  });

  it('refuses someone from another organization, whatever organizationId they pass', async () => {
    const res = await rpc('outsider', 'call_read_operation', { name: 'teams.list', arguments: { organizationId: org.id } });
    expect(res.text).toMatch(/not a member of this organization/);
  });

  it('validates the body as the route does', async () => {
    const res = await rpc('owner', 'call_write_operation', { name: 'teams.create', arguments: { body: { name: 'x', color: 'red' } } });
    expect(res.text).toMatch(/property color should not exist/);
  });

  it('deletes only through the destructive call tool', async () => {
    const team = await ds.getRepository(Team).findOneOrFail({ where: { organizationId: org.id, name: `Ops ${SUFFIX}` } });
    const wrong = await rpc('owner', 'call_write_operation', { name: 'teams.delete', arguments: { teamId: team.id } });
    expect(wrong.text).toMatch(/call_destructive_operation/);
    expect(await ds.getRepository(Team).count({ where: { id: team.id } })).toBe(1);

    const res = await rpc('owner', 'call_destructive_operation', { name: 'teams.delete', arguments: { teamId: team.id } });
    expect(res.isError).toBe(false);
    expect(await ds.getRepository(Team).count({ where: { id: team.id } })).toBe(0);
  });

  it('holds a curated tool to its REST twin: list_org_members is member and up', async () => {
    expect((await rpc('viewer', 'list_org_members')).text).toMatch(/Insufficient role privileges/);
    const { json } = await rpc('member', 'list_org_members');
    expect(json.members.map((m: any) => m.userId)).toEqual(expect.arrayContaining([users.owner, users.member]));
  });
});
