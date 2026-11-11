/**
 * Integration test: the management-MCP operations that were held for a
 * product decision, against Postgres.
 *
 * Deleting the organization, inviting a member and minting a platform API
 * key run through the real OrganizationsController / AuthController and
 * their services over a real database, with their own guards: the row
 * changes for the role the route allows, and nothing changes for a role
 * below it or for someone from another organization.
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
import { ApiKey } from '../../entities/api-key.entity';
import { AuthService } from '../../modules/auth/auth.service';
import { AuditLogService } from '../../modules/audit-log/audit-log.service';
import { AlmytyMcpService } from '../../modules/mcp/almyty-mcp.service';
import { useIsolatedSchema, ensureSchema } from './isolated-schema.helper';

const SCHEMA = 'management_mcp_held_test';
if (!SKIP) useIsolatedSchema(SCHEMA);

(SKIP ? describe.skip : describe)('Management MCP: held operations (integration)', () => {
  let module: TestingModule;
  let ds: DataSource;
  let mcp: AlmytyMcpService;
  let org: Organization;
  const users: Record<'owner' | 'admin' | 'member' | 'outsider' | 'invitee', string> = {} as any;
  const emails: Record<string, string> = {};
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
    module = await Test.createTestingModule({ imports: [TestAppModule] })
      .overrideProvider(AuditLogService)
      .useValue(audit)
      .compile();
    await module.init();
    ds = module.get(DataSource);
    mcp = module.get(AlmytyMcpService);
    const auth = module.get(AuthService);

    org = await ds.getRepository(Organization).save(
      ds.getRepository(Organization).create({ name: `Held MCP ${SUFFIX}`, slug: `held-mcp-${SUFFIX}` }),
    );
    const roles: Array<[keyof typeof users, OrganizationRole | null]> = [
      ['owner', OrganizationRole.OWNER],
      ['admin', OrganizationRole.ADMIN],
      ['member', OrganizationRole.MEMBER],
      ['outsider', null],
      ['invitee', null],
    ];
    for (const [key, role] of roles) {
      const email = `held-${key}-${SUFFIX}@test.com`;
      emails[key] = email;
      await auth.register({ email, password: 'TestPass123!', firstName: key, lastName: 'User', organizationName: `held-${key}-own-${SUFFIX}` });
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

  const rpc = async (who: keyof typeof users, name: string, args: any = {}, orgId = org.id) => {
    const res: any = await mcp.handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, orgId, users[who]);
    const text: string = res.result.content[0].text;
    return { isError: !!res.result.isError, text, json: res.result.isError ? null : JSON.parse(text) };
  };
  const membershipOf = (userId: string) => ds.getRepository(UserOrganization).findOne({ where: { userId, organizationId: org.id } });

  describe('members.invite', () => {
    it('refuses a member and an outsider, and writes no membership', async () => {
      const body = { email: emails.invitee, role: 'member' };
      expect((await rpc('member', 'call_write_operation', { name: 'members.invite', arguments: { body } })).text).toMatch(/Insufficient role privileges/);
      expect((await rpc('outsider', 'call_write_operation', { name: 'members.invite', arguments: { body } })).text).toMatch(/not a member of this organization/);
      expect(await membershipOf(users.invitee)).toBeNull();
    });

    it('invites an existing user for an admin: a pending membership with the role, audited as the MCP', async () => {
      const res = await rpc('admin', 'call_write_operation', { name: 'members.invite', arguments: { body: { email: emails.invitee, role: 'member' } } });
      expect(res.isError).toBe(false);
      const row = await membershipOf(users.invitee);
      expect(row).toBeTruthy();
      expect(row!.role).toBe(OrganizationRole.MEMBER);
      expect(row!.inviteAccepted).toBe(false);
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ organizationId: org.id, userId: users.admin, userAgent: 'almyty-mcp' }));
    });

    it('refuses an admin inviting above their own role, as REST does', async () => {
      const res = await rpc('admin', 'call_write_operation', { name: 'members.invite', arguments: { body: { email: emails.outsider, role: 'owner' } } });
      expect(res.isError).toBe(true);
      expect(await membershipOf(users.outsider)).toBeNull();
    });
  });

  describe('profile.create_api_key', () => {
    it('mints a key for the caller and returns it once, stored only as a hash', async () => {
      const res = await rpc('member', 'call_write_operation', { name: 'profile.create_api_key', arguments: { body: { name: `mcp ${SUFFIX}` } } });
      expect(res.isError).toBe(false);
      const plaintext: string = res.json.data.apiKey;
      expect(typeof plaintext).toBe('string');
      const row = await ds.getRepository(ApiKey).findOneOrFail({ where: { id: res.json.data.keyData.id } });
      expect(row.userId).toBe(users.member);
      expect(row.keyHash).not.toBe(plaintext);
      expect(plaintext.startsWith(row.keyPrefix)).toBe(true);
      // Listing shows the prefix, never the key.
      const listed = await rpc('member', 'call_read_operation', { name: 'profile.list_api_keys' });
      expect(listed.text).not.toContain(plaintext);
    });

    it('refuses someone from another organization, and mints nothing', async () => {
      const before = await ds.getRepository(ApiKey).count({ where: { userId: users.outsider } });
      const res = await rpc('outsider', 'call_write_operation', { name: 'profile.create_api_key', arguments: { body: { name: 'x' } } });
      expect(res.text).toMatch(/not a member of this organization/);
      expect(await ds.getRepository(ApiKey).count({ where: { userId: users.outsider } })).toBe(before);
    });
  });

  describe('organization.delete', () => {
    it('refuses an admin, refuses the write tool, and deletes for the owner through the destructive one', async () => {
      const doomed = await ds.getRepository(Organization).save(
        ds.getRepository(Organization).create({ name: `Doomed ${SUFFIX}`, slug: `doomed-${SUFFIX}` }),
      );
      for (const [who, role] of [['owner', OrganizationRole.OWNER], ['admin', OrganizationRole.ADMIN]] as const) {
        await ds.getRepository(UserOrganization).save(
          ds.getRepository(UserOrganization).create({ userId: users[who], organizationId: doomed.id, role }),
        );
      }
      const exists = () => ds.getRepository(Organization).count({ where: { id: doomed.id } });

      expect((await rpc('admin', 'call_destructive_operation', { name: 'organization.delete' }, doomed.id)).text).toMatch(/Insufficient role privileges/);
      expect((await rpc('outsider', 'call_destructive_operation', { name: 'organization.delete' }, doomed.id)).text).toMatch(/not a member of this organization/);
      expect((await rpc('owner', 'call_write_operation', { name: 'organization.delete' }, doomed.id)).text).toMatch(/call_destructive_operation/);
      expect(await exists()).toBe(1);

      const res = await rpc('owner', 'call_destructive_operation', { name: 'organization.delete', arguments: { organizationId: org.id } }, doomed.id);
      expect(res.text).not.toMatch(/^Error/);
      expect(await exists()).toBe(0);
      // The organizationId argument is ignored: the endpoint's organization is the one deleted.
      expect(await ds.getRepository(Organization).count({ where: { id: org.id } })).toBe(1);
    });
  });
});
