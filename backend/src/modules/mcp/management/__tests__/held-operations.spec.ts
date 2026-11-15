import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AlmytyMcpService } from '../../almyty-mcp.service';
import { ManagementOperationsService, MANAGEMENT_OPERATIONS } from '../management-operations.service';
import { ADVANCED_RBAC_HOOK } from '../../../../common/ee-hooks/ee-hooks';
import { ManagementRouteInvoker } from '../route-invoker.service';
import { LicenseService } from '../../../licensing/license.service';
import { OrgLicenseResolver } from '../../../licensing/org-license.resolver';
import { User } from '../../../../entities/user.entity';
import { OrganizationRole, UserOrganization } from '../../../../entities/user-organization.entity';
import { OrganizationsController } from '../../../organizations/organizations.controller';
import { OrganizationsService } from '../../../organizations/organizations.service';
import { UsersController } from '../../../users/users.controller';
import { UsersService } from '../../../users/users.service';
import { AuthController } from '../../../auth/auth.controller';
import { AuthService } from '../../../auth/auth.service';
import { CredentialsController } from '../../../credentials/credentials.controller';
import { CredentialsService } from '../../../credentials/credentials.service';
import { GatewayAuthController } from '../../../gateways/gateway-auth.controller';
import { GatewayAuthService } from '../../../gateways/gateway-auth.service';
import { GatewaysController } from '../../../gateways/gateways.controller';
import { GatewaysService } from '../../../gateways/gateways.service';
import { PrivateGatewayGuard } from '../../../gateways/private-gateway.guard';
import { GatewayAuthManagementGuard } from '../../../gateways/gateway-auth-management.guard';
import { ToolsController } from '../../../tools/tools.controller';
import { ToolsService } from '../../../tools/tools.service';
import { PrivateToolGuard } from '../../../../common/authorization/private-resource.guard';
import { RetentionController } from '../../../retention/retention.controller';
import { RetentionService } from '../../../retention/retention.service';
import { KmsController } from '../../../kms/kms.controller';
import { KmsProvisioningService } from '../../../kms/kms-provisioning.service';
// EE classes are required, not imported: src/ compiles without ee/ (rootDir).
const EE = '../../../../../ee/modules';
const { SsoConfigController } = require(`${EE}/sso/sso-config.controller`);
const { SsoConfigService } = require(`${EE}/sso/sso-config.service`);
const { BillingController } = require(`${EE}/billing/billing.controller`);
const { BillingService } = require(`${EE}/billing/billing.service`);

/**
 * The routes that waited for a product decision, now operations: each
 * group through the real controller and its real guards (RolesGuard,
 * EntitlementGuard), with the services behind them mocked. For each: the
 * happy path, a role below the route's, a caller from another
 * organization, the EE gate where the route has one, and the call tool the
 * effect demands. The private-resource guards are stubbed open; they are
 * covered by their own specs.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const TARGET = '44444444-4444-4444-8444-444444444444';
const GATEWAY = '55555555-5555-4555-8555-555555555555';
const TOOL = '66666666-6666-4666-8666-666666666666';
const DOMAIN = '77777777-7777-4777-8777-777777777777';

function membership(organizationId: string, role: OrganizationRole): UserOrganization {
  return Object.assign(new UserOrganization(), { organizationId, role, isActive: true, inviteAccepted: true, inviteToken: null });
}

const USERS: Record<string, any> = {
  owner: { id: 'owner', email: 'o@x.test', isActive: true, organizationMemberships: [membership(ORG, OrganizationRole.OWNER)] },
  admin: { id: 'admin', email: 'a@x.test', isActive: true, organizationMemberships: [membership(ORG, OrganizationRole.ADMIN)] },
  member: { id: 'member', email: 'm@x.test', isActive: true, organizationMemberships: [membership(ORG, OrganizationRole.MEMBER)] },
  viewer: { id: 'viewer', email: 'v@x.test', isActive: true, organizationMemberships: [membership(ORG, OrganizationRole.VIEWER)] },
  outsider: { id: 'outsider', email: 'x@x.test', isActive: true, organizationMemberships: [membership(OTHER_ORG, OrganizationRole.OWNER)] },
};

/** A service whose every method is a jest.fn, created on first use. */
function autoMock(): any {
  const fns: Record<string | symbol, jest.Mock> = {};
  return new Proxy(fns, {
    get: (target, prop) => {
      if (prop === 'then' || prop === 'onModuleInit' || prop === 'onApplicationBootstrap' || prop === 'onModuleDestroy') return undefined;
      return (target[prop] ??= jest.fn().mockResolvedValue({ ok: true }));
    },
  });
}

const open = { canActivate: () => true };

describe('management MCP: the operations that were held', () => {
  let module: TestingModule;
  let mcp: AlmytyMcpService;
  let entitlements: string[];
  // One mock per token, shared by every class that injects it.
  const mocks = new Map<unknown, any>();
  const svc = (token: unknown): any => mocks.get(token);

  beforeAll(async () => {
    module = await Test.createTestingModule({
      controllers: [
        OrganizationsController,
        UsersController,
        AuthController,
        CredentialsController,
        GatewayAuthController,
        GatewaysController,
        ToolsController,
        RetentionController,
        KmsController,
        SsoConfigController,
        BillingController,
      ],
      providers: [
        AlmytyMcpService,
        ManagementRouteInvoker,
        ManagementOperationsService,
        {
          provide: getRepositoryToken(User),
          useValue: {
            findOne: async ({ where }: any) => {
              const user = USERS[where.id] ? structuredClone(USERS[where.id]) : null;
              if (user) user.organizationMemberships = user.organizationMemberships.map((m: any) => Object.assign(new UserOrganization(), m));
              return user;
            },
          },
        },
        { provide: LicenseService, useValue: { has: () => false } },
        { provide: OrgLicenseResolver, useValue: { entitlementsForOrg: async () => ({ entitlements }) } },
        { provide: ADVANCED_RBAC_HOOK, useValue: null },
        { provide: MANAGEMENT_OPERATIONS, useValue: null },
      ],
    })
      // Everything else the controllers inject is a mock. The optional EE
      // RBAC hook and the operation-catalog override are provided as absent
      // above, as in the community build; a pipe's optional options object
      // (ValidationPipe, ParseUUIDPipe) stays unset.
      .useMocker((token) => {
        if (token === Object) return null;
        if (!mocks.has(token)) mocks.set(token, autoMock());
        return mocks.get(token);
      })
      .overrideGuard(PrivateGatewayGuard)
      .useValue(open)
      .overrideGuard(GatewayAuthManagementGuard)
      .useValue(open)
      .overrideGuard(PrivateToolGuard)
      .useValue(open)
      .compile();
    mcp = module.get(AlmytyMcpService);
  }, 120_000);

  afterAll(async () => {
    await module?.close();
  });

  beforeEach(() => {
    entitlements = [];
    jest.clearAllMocks();
  });

  const rpc = async (userId: string, tool: string, name: string, args: any = {}) => {
    const res: any = await mcp.handleJsonRpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: { name, arguments: args } } },
      ORG,
      userId,
    );
    const text = res.result.content[0].text as string;
    return { isError: !!res.result.isError, text, json: res.result.isError ? null : JSON.parse(text) };
  };
  const write = (u: string, n: string, a?: any) => rpc(u, 'call_write_operation', n, a);
  const destroy = (u: string, n: string, a?: any) => rpc(u, 'call_destructive_operation', n, a);
  const describeOp = async (n: string) => {
    const res: any = await mcp.handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_operation', arguments: { name: n } } }, ORG, 'owner');
    return JSON.parse(res.result.content[0].text);
  };

  describe('the organization', () => {
    it('deletes it for an owner, only through call_destructive_operation', async () => {
      expect((await describeOp('organization.delete')).callWith).toBe('call_destructive_operation');
      const viaWrite = await write('owner', 'organization.delete');
      expect(viaWrite.isError).toBe(true);
      expect(viaWrite.text).toContain('call_destructive_operation');
      const res = await destroy('owner', 'organization.delete');
      expect(res.isError).toBe(false);
      expect(svc(OrganizationsService).delete).toHaveBeenCalledWith(ORG);
    });

    it('refuses an admin (owner only) and a caller from another organization', async () => {
      expect((await destroy('admin', 'organization.delete')).isError).toBe(true);
      expect((await destroy('outsider', 'organization.delete')).text).toContain('not a member');
      expect(svc(OrganizationsService).delete).not.toHaveBeenCalled();
    });

    it('creates another organization for a member, and refuses an outsider', async () => {
      const res = await write('member', 'organization.create', { body: { name: 'Second' } });
      expect(res.isError).toBe(false);
      expect(svc(OrganizationsService).create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Second' }), 'member');
      expect((await write('outsider', 'organization.create', { body: { name: 'X' } })).isError).toBe(true);
      expect(svc(OrganizationsService).create).toHaveBeenCalledTimes(1);
    });
  });

  describe('members and invites', () => {
    it('invites for an admin, validated by the route DTO', async () => {
      svc(OrganizationsService).inviteUser.mockResolvedValue({ inviteSent: true });
      const res = await write('admin', 'members.invite', { body: { email: 'new@x.test', role: 'member' } });
      expect(res.isError).toBe(false);
      expect(svc(OrganizationsService).inviteUser).toHaveBeenCalledWith(ORG, expect.objectContaining({ email: 'new@x.test', role: 'member' }), 'admin');
      expect((await write('admin', 'members.invite', { body: { email: 'not-an-email', role: 'member' } })).isError).toBe(true);
    });

    it('refuses a member and an outsider', async () => {
      expect((await write('member', 'members.invite', { body: { email: 'n@x.test', role: 'member' } })).isError).toBe(true);
      expect((await write('outsider', 'members.invite', { body: { email: 'n@x.test', role: 'member' } })).isError).toBe(true);
      expect(svc(OrganizationsService).inviteUser).not.toHaveBeenCalled();
    });

    it('changes a role (write) and removes a member and revokes an invite (destructive)', async () => {
      expect((await write('admin', 'members.update_role', { userId: TARGET, body: { role: 'viewer' } })).isError).toBe(false);
      expect(svc(OrganizationsService).updateMemberRole).toHaveBeenCalledWith(ORG, TARGET, 'viewer', 'admin');
      expect((await write('admin', 'members.remove', { userId: TARGET })).isError).toBe(true);
      expect((await destroy('admin', 'members.remove', { userId: TARGET })).isError).toBe(false);
      expect(svc(OrganizationsService).removeMember).toHaveBeenCalledWith(ORG, TARGET, 'admin');
      expect((await destroy('admin', 'members.revoke_invite', { inviteId: 'inv-1' })).isError).toBe(false);
      expect(svc(OrganizationsService).revokePendingInvite).toHaveBeenCalledWith(ORG, 'inv-1');
    });

    it('refuses role changes and removals below admin', async () => {
      expect((await write('member', 'members.update_role', { userId: TARGET, body: { role: 'owner' } })).isError).toBe(true);
      expect((await destroy('member', 'members.remove', { userId: TARGET })).isError).toBe(true);
      expect((await destroy('outsider', 'members.remove', { userId: TARGET })).isError).toBe(true);
      expect(svc(OrganizationsService).updateMemberRole).not.toHaveBeenCalled();
      expect(svc(OrganizationsService).removeMember).not.toHaveBeenCalled();
    });
  });

  describe('user accounts', () => {
    beforeEach(() => {
      svc(UsersService).updateInOrg.mockResolvedValue({ id: TARGET, firstName: 'New', passwordHash: 'h' });
    });

    it('edits another user for an admin, never returning the password hash', async () => {
      const res = await write('admin', 'users.update', { id: TARGET, body: { firstName: 'New' } });
      expect(res.isError).toBe(false);
      expect(res.text).not.toContain('passwordHash');
      expect(svc(UsersService).updateInOrg).toHaveBeenCalledWith(TARGET, ORG, expect.objectContaining({ firstName: 'New' }), 'admin');
    });

    it('takes no password: left out of the schema, refused on call', async () => {
      expect(JSON.stringify((await describeOp('users.update')).inputSchema)).not.toContain('currentPassword');
      const res = await write('admin', 'users.update', { id: TARGET, body: { currentPassword: 'hunter2' } });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('body.currentPassword');
      expect(res.text).toContain('/settings/security');
      expect(svc(UsersService).updateInOrg).not.toHaveBeenCalled();
    });

    it('refuses a member and an outsider', async () => {
      expect((await write('member', 'users.update', { id: TARGET, body: { firstName: 'X' } })).isError).toBe(true);
      expect((await write('outsider', 'users.update', { id: TARGET, body: { firstName: 'X' } })).isError).toBe(true);
      expect((await write('member', 'users.deactivate', { id: TARGET })).isError).toBe(true);
      expect(svc(UsersService).updateInOrg).not.toHaveBeenCalled();
    });

    it('deactivates and reactivates for an admin; deletes for an owner only, destructively', async () => {
      expect((await write('admin', 'users.deactivate', { id: TARGET })).isError).toBe(false);
      expect((await write('admin', 'users.reactivate', { id: TARGET })).isError).toBe(false);
      expect((await describeOp('users.delete')).callWith).toBe('call_destructive_operation');
      expect((await destroy('admin', 'users.delete', { id: TARGET })).isError).toBe(true);
      expect((await destroy('outsider', 'users.delete', { id: TARGET })).isError).toBe(true);
      expect((await destroy('owner', 'users.delete', { id: TARGET })).isError).toBe(false);
    });
  });

  describe('minting keys: shown once, in plaintext, as over REST', () => {
    it('says so in every description, and runs each through call_write_operation', async () => {
      for (const name of ['profile.create_api_key', 'credentials.create_access_key', 'gateways.create_api_key']) {
        const op = await describeOp(name);
        expect(op.callWith).toBe('call_write_operation');
        expect(op.summary).toContain('shown only once');
      }
    });

    it('mints a platform API key for the caller and returns it', async () => {
      svc(AuthService).createApiKey.mockResolvedValue({ apiKey: 'almyty_live_abc', keyData: { id: 'k1', name: 'ci', keyPrefix: 'almyty_l' } });
      const res = await write('member', 'profile.create_api_key', { body: { name: 'ci' } });
      expect(res.isError).toBe(false);
      expect(res.json.data.apiKey).toBe('almyty_live_abc');
      // Scoped to the org the call is made in, as a key minted in the web app is.
      expect(svc(AuthService).createApiKey).toHaveBeenCalledWith('member', expect.objectContaining({ name: 'ci' }), ORG);
      expect((await write('outsider', 'profile.create_api_key', { body: { name: 'ci' } })).isError).toBe(true);
    });

    it('mints an access key for an admin, refuses a member and an outsider', async () => {
      svc(CredentialsService).createAccessKey.mockResolvedValue({ key: { id: 'ak1' }, plainTextKey: 'ak_plain' });
      const res = await write('admin', 'credentials.create_access_key', { body: { name: 'deploy' } });
      expect(res.isError).toBe(false);
      expect(res.json.data.plainTextKey).toBe('ak_plain');
      expect((await write('member', 'credentials.create_access_key', { body: { name: 'deploy' } })).isError).toBe(true);
      expect((await write('outsider', 'credentials.create_access_key', { body: { name: 'deploy' } })).isError).toBe(true);
      expect(svc(CredentialsService).createAccessKey).toHaveBeenCalledTimes(1);
    });

    it('mints a gateway key for a member, refuses a viewer and an outsider', async () => {
      svc(GatewaysService).getGateway.mockResolvedValue({ id: GATEWAY, name: 'gw' });
      svc(GatewayAuthService).generateApiKey.mockResolvedValue({ id: 'gk1', key: 'gk_plain', name: 'gw API Key' });
      const res = await write('member', 'gateways.create_api_key', { gatewayId: GATEWAY, body: { name: 'gw' } });
      expect(res.text).not.toMatch(/^Error/);
      expect(res.text).toContain('gk_plain');
      expect((await write('viewer', 'gateways.create_api_key', { gatewayId: GATEWAY, body: { name: 'gw' } })).isError).toBe(true);
      expect((await write('outsider', 'gateways.create_api_key', { gatewayId: GATEWAY, body: { name: 'gw' } })).isError).toBe(true);
      expect(svc(GatewayAuthService).generateApiKey).toHaveBeenCalledTimes(1);
    });
  });

  describe('single sign-on (EE: sso)', () => {
    it('is refused without the entitlement, and runs with it for an admin', async () => {
      const without = await write('admin', 'sso.update_settings', { body: { protocol: 'oidc' } });
      expect(without.isError).toBe(true);
      expect(svc(SsoConfigService).upsert).not.toHaveBeenCalled();
      entitlements = ['sso'];
      svc(SsoConfigService).upsert.mockResolvedValue({ id: 's1' });
      svc(SsoConfigService).toPublicView.mockReturnValue({ id: 's1' });
      expect((await write('admin', 'sso.update_settings', { body: { protocol: 'oidc' } })).isError).toBe(false);
      expect(svc(SsoConfigService).upsert).toHaveBeenCalledWith(ORG, { protocol: 'oidc' });
    });

    it('refuses a member and an outsider, and a client secret in the arguments', async () => {
      entitlements = ['sso'];
      expect((await write('member', 'sso.update_settings', { body: { protocol: 'oidc' } })).isError).toBe(true);
      expect((await write('outsider', 'sso.update_settings', { body: { protocol: 'oidc' } })).isError).toBe(true);
      const secret = await write('admin', 'sso.update_settings', { body: { protocol: 'oidc', oidcClientSecret: 's3cr3t' } });
      expect(secret.isError).toBe(true);
      expect(secret.text).toContain('/settings/sso');
      expect(svc(SsoConfigService).upsert).not.toHaveBeenCalled();
    });

    it('adds and verifies a domain (write) and removes one (destructive)', async () => {
      entitlements = ['sso'];
      expect((await write('admin', 'sso.add_domain', { body: { domain: 'x.test' } })).isError).toBe(false);
      expect((await write('admin', 'sso.verify_domain', { id: DOMAIN })).isError).toBe(false);
      expect((await write('admin', 'sso.remove_domain', { id: DOMAIN })).isError).toBe(true);
      expect((await destroy('admin', 'sso.remove_domain', { id: DOMAIN })).isError).toBe(false);
      expect((await destroy('member', 'sso.remove_domain', { id: DOMAIN })).isError).toBe(true);
    });
  });

  describe('customer-managed encryption key (EE: byo_kms)', () => {
    const cmk = { cmkArn: 'arn:aws:kms:eu-west-1:123456789012:key/abc', awsRegion: 'eu-west-1' };

    it('is refused without the entitlement, and sets the key with it', async () => {
      expect((await write('admin', 'kms.set_key', { body: cmk })).isError).toBe(true);
      entitlements = ['byo_kms'];
      expect((await write('admin', 'kms.set_key', { body: cmk })).isError).toBe(false);
      expect(svc(KmsProvisioningService).attachCmk).toHaveBeenCalledWith(ORG, expect.objectContaining({ cmkArn: cmk.cmkArn }));
      expect((await write('admin', 'kms.rotate_key', { body: {} })).isError).toBe(false);
    });

    it('turns encryption off only through call_destructive_operation', async () => {
      entitlements = ['byo_kms'];
      expect((await write('admin', 'kms.set_enabled', { body: { enabled: false } })).isError).toBe(true);
      expect((await destroy('admin', 'kms.set_enabled', { body: { enabled: false } })).isError).toBe(false);
      expect(svc(KmsProvisioningService).setEnabled).toHaveBeenCalledWith(ORG, false);
    });

    it('refuses a member and an outsider', async () => {
      entitlements = ['byo_kms'];
      expect((await destroy('member', 'kms.set_enabled', { body: { enabled: false } })).isError).toBe(true);
      expect((await write('outsider', 'kms.set_key', { body: cmk })).isError).toBe(true);
      expect(svc(KmsProvisioningService).setEnabled).not.toHaveBeenCalled();
      expect(svc(KmsProvisioningService).attachCmk).not.toHaveBeenCalled();
    });
  });

  describe('billing', () => {
    it('returns the checkout and portal URLs for an admin', async () => {
      svc(BillingService).createCheckoutSession.mockResolvedValue({ url: 'https://checkout.stripe.test/c/1' });
      svc(BillingService).createPortalSession.mockResolvedValue({ url: 'https://billing.stripe.test/p/1' });
      const checkout = await write('admin', 'billing.create_checkout', { body: { plan: 'pro' } });
      expect(checkout.json.data.url).toBe('https://checkout.stripe.test/c/1');
      const portal = await write('admin', 'billing.open_portal');
      expect(portal.json.data.url).toBe('https://billing.stripe.test/p/1');
    });

    it('refuses a member and an outsider', async () => {
      expect((await write('member', 'billing.create_checkout', { body: { plan: 'pro' } })).isError).toBe(true);
      expect((await write('outsider', 'billing.open_portal')).isError).toBe(true);
      expect(svc(BillingService).createCheckoutSession).not.toHaveBeenCalled();
      expect(svc(BillingService).createPortalSession).not.toHaveBeenCalled();
    });
  });

  describe('data retention', () => {
    it('changes it only through call_destructive_operation, for an admin', async () => {
      expect((await write('admin', 'organization.update_retention', { body: { agentRunsDays: 7 } })).isError).toBe(true);
      expect((await destroy('admin', 'organization.update_retention', { body: { agentRunsDays: 7 } })).isError).toBe(false);
      expect(svc(RetentionService).upsertPolicy).toHaveBeenCalledWith(ORG, expect.objectContaining({ agentRunsDays: 7 }), 'admin');
    });

    it('refuses a member and an outsider', async () => {
      expect((await destroy('member', 'organization.update_retention', { body: { agentRunsDays: 7 } })).isError).toBe(true);
      expect((await destroy('outsider', 'organization.update_retention', { body: { agentRunsDays: 7 } })).isError).toBe(true);
      expect(svc(RetentionService).upsertPolicy).not.toHaveBeenCalled();
    });
  });

  describe('editing a gateway and writing tools by hand', () => {
    it('updates a gateway for an admin, refuses a member, an outsider and a secret header', async () => {
      svc(GatewaysService).updateGateway.mockResolvedValue({ id: GATEWAY, name: 'renamed' });
      expect((await write('admin', 'gateways.update', { gatewayId: GATEWAY, body: { name: 'renamed' } })).text).not.toMatch(/^Error/);
      expect(svc(GatewaysService).updateGateway).toHaveBeenCalledTimes(1);
      expect((await write('member', 'gateways.update', { gatewayId: GATEWAY, body: { name: 'x' } })).isError).toBe(true);
      expect((await write('outsider', 'gateways.update', { gatewayId: GATEWAY, body: { name: 'x' } })).isError).toBe(true);
      const secret = await write('admin', 'gateways.update', { gatewayId: GATEWAY, body: { customHeaders: { Authorization: 'Bearer live' } } });
      expect(secret.isError).toBe(true);
      expect(secret.text).toContain('body.customHeaders.Authorization');
      expect(svc(GatewaysService).updateGateway).toHaveBeenCalledTimes(1);
    });

    it('creates and updates a tool for a member, refuses a viewer, an outsider and a key in its auth', async () => {
      svc(ToolsService).createTool.mockResolvedValue({ id: TOOL, name: 'lookup' });
      svc(ToolsService).updateTool.mockResolvedValue({ id: TOOL, name: 'lookup' });
      const tool = { name: 'lookup', type: 'function', description: 'Look a thing up', parameters: { type: 'object', properties: {} } };
      const created = await write('member', 'tools.create', { body: tool });
      expect(created.text).not.toMatch(/^Error/);
      expect(svc(ToolsService).createTool).toHaveBeenCalledTimes(1);
      expect((await write('member', 'tools.update', { toolId: TOOL, body: { description: 'Look it up faster' } })).text).not.toMatch(/^Error/);
      expect(svc(ToolsService).updateTool).toHaveBeenCalledTimes(1);
      expect((await write('viewer', 'tools.create', { body: tool })).isError).toBe(true);
      expect((await write('outsider', 'tools.create', { body: tool })).isError).toBe(true);
      const secret = await write('member', 'tools.update', { toolId: TOOL, body: { authConfig: { type: 'bearer', token: 'live' } } });
      expect(secret.isError).toBe(true);
      expect(secret.text).toContain('body.authConfig.token');
      expect(svc(ToolsService).updateTool).toHaveBeenCalledTimes(1);
    });
  });

  describe('operations that take a secret', () => {
    it('answer with the app page that takes it, not by running', async () => {
      const add = await write('admin', 'credentials.add', { body: { name: 'x', config: { apiKey: 'sk' } } });
      expect(add.isError).toBe(true);
      expect(add.text).toContain('takes a secret');
      expect(add.text).toContain('/credentials/new');
      const rotate = await write('admin', 'credentials.rotate', { id: TARGET });
      expect(rotate.text).toContain(`/credentials/${TARGET}`);
      expect(svc(CredentialsService).create).not.toHaveBeenCalled();
    });
  });
});
