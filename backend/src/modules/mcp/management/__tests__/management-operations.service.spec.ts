import 'reflect-metadata';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  Request,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

import { AlmytyMcpService } from '../../almyty-mcp.service';
import { ManagementOperationsService, MANAGEMENT_OPERATIONS } from '../management-operations.service';
import { ManagementRouteInvoker } from '../route-invoker.service';
import { OperationEntry } from '../management-operations';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { Roles } from '../../../auth/decorators/roles.decorator';
import { EntitlementGuard } from '../../../licensing/guards/entitlement.guard';
import { RequiresEntitlement } from '../../../licensing/decorators/requires-entitlement.decorator';
import { LicenseService } from '../../../licensing/license.service';
import { OrgLicenseResolver } from '../../../licensing/org-license.resolver';
import { Public } from '../../../../common/decorators/public.decorator';
import { User } from '../../../../entities/user.entity';
import { OrganizationRole, UserOrganization } from '../../../../entities/user-organization.entity';
import { ApisService } from '../../../apis/apis.service';
import { TempFileInterceptor } from '../../../files/temp-upload';

@Injectable()
class TracingInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler) {
    return next.handle();
  }
}

/**
 * The management MCP's operations, end to end through the real machinery:
 * AlmytyMcpService's meta-tools, ManagementOperationsService, and the
 * route invoker running real controller handlers with the real RolesGuard
 * and EntitlementGuard. Only the routes are fakes (a small controller
 * decorated the way the platform's are) and the user table is in memory.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const WIDGET_ID = '33333333-3333-4333-8333-333333333333';

class CreateWidgetDto {
  @IsString()
  @MaxLength(40)
  name!: string;

  @IsOptional()
  @IsIn(['small', 'large'])
  size?: string;
}

class SearchWidgetsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

const calls: any[] = [];

@Controller('widgets')
@UseGuards(JwtAuthGuard, RolesGuard)
class WidgetsController {
  @Get()
  @Roles('viewer', 'member', 'admin', 'owner')
  list(@Request() req: any, @Query() query: SearchWidgetsDto) {
    calls.push({ handler: 'list', org: req.user.currentOrganizationId, query });
    return { success: true, data: [{ id: WIDGET_ID }], limit: query.limit ?? null };
  }

  @Post()
  @Roles('admin', 'owner')
  create(@Body() dto: CreateWidgetDto, @Request() req: any) {
    calls.push({ handler: 'create', dto, by: req.user.id, ua: req.headers['user-agent'] });
    return { success: true, data: { id: WIDGET_ID, ...dto } };
  }

  @Delete(':id')
  @Roles('owner')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    calls.push({ handler: 'remove', id });
    return { success: true, deleted: id };
  }

  @Get('premium')
  @Roles('member', 'admin', 'owner')
  @UseGuards(EntitlementGuard)
  @RequiresEntitlement('advanced_rbac')
  premium() {
    return { success: true, premium: true };
  }

  @Get('broken')
  @Roles('member', 'admin', 'owner')
  broken() {
    throw new Error('select * from secrets failed at host db-1');
  }

  @Post('import')
  @Roles('member', 'admin', 'owner')
  @UseInterceptors(TempFileInterceptor('file', 1024))
  importWidgets(@Body() body: any, @UploadedFile() file?: any) {
    return { success: true, url: body.url, file: file ?? null };
  }

  @Get('traced')
  @Roles('member', 'admin', 'owner')
  @UseInterceptors(TracingInterceptor)
  traced() {
    return { success: true };
  }

  @Get('open')
  @Public()
  open() {
    return { success: true, open: true };
  }
}

@Controller('organizations/:organizationId/gadgets')
@UseGuards(JwtAuthGuard, RolesGuard)
class GadgetsController {
  @Get()
  @Roles('member', 'admin', 'owner')
  list(@Param('organizationId') organizationId: string) {
    return { organizationId };
  }
}

@Controller('unguarded')
class UnguardedController {
  @Get()
  list() {
    return { open: true };
  }
}

const CATALOG: OperationEntry[] = [
  { name: 'widgets.list', route: 'WidgetsController.list' },
  { name: 'widgets.create', route: 'WidgetsController.create' },
  { name: 'widgets.remove', route: 'WidgetsController.remove' },
  { name: 'widgets.premium', route: 'WidgetsController.premium' },
  { name: 'widgets.broken', route: 'WidgetsController.broken' },
  { name: 'widgets.open', route: 'WidgetsController.open' },
  { name: 'widgets.import', route: 'WidgetsController.importWidgets' },
  { name: 'widgets.traced', route: 'WidgetsController.traced' },
  { name: 'gadgets.list', route: 'GadgetsController.list' },
  { name: 'unguarded.list', route: 'UnguardedController.list' },
  { name: 'ee.missing', route: 'NotLoadedController.list' },
];

function membership(organizationId: string, role: OrganizationRole, extra: Partial<UserOrganization> = {}): UserOrganization {
  return Object.assign(new UserOrganization(), {
    organizationId,
    role,
    isActive: true,
    inviteAccepted: true,
    inviteToken: null,
    ...extra,
  });
}

const USERS: Record<string, any> = {
  owner: { id: 'owner', email: 'o@x.test', isActive: true, organizationMemberships: [membership(ORG, OrganizationRole.OWNER)] },
  admin: { id: 'admin', email: 'a@x.test', isActive: true, organizationMemberships: [membership(ORG, OrganizationRole.ADMIN)] },
  member: { id: 'member', email: 'm@x.test', isActive: true, organizationMemberships: [membership(ORG, OrganizationRole.MEMBER)] },
  viewer: { id: 'viewer', email: 'v@x.test', isActive: true, organizationMemberships: [membership(ORG, OrganizationRole.VIEWER)] },
  outsider: { id: 'outsider', email: 'x@x.test', isActive: true, organizationMemberships: [membership(OTHER_ORG, OrganizationRole.OWNER)] },
  revoked: { id: 'revoked', email: 'r@x.test', isActive: true, organizationMemberships: [membership(ORG, OrganizationRole.ADMIN, { isActive: false })] },
  disabled: { id: 'disabled', email: 'd@x.test', isActive: false, organizationMemberships: [membership(ORG, OrganizationRole.OWNER)] },
};

describe('management MCP operations', () => {
  let module: TestingModule;
  let mcp: AlmytyMcpService;
  let entitlements: string[];
  const apis = { remove: jest.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    calls.length = 0;
    entitlements = [];
    apis.remove.mockClear();
    module = await Test.createTestingModule({
      controllers: [WidgetsController, GadgetsController, UnguardedController],
      providers: [
        AlmytyMcpService,
        ManagementRouteInvoker,
        ManagementOperationsService,
        { provide: MANAGEMENT_OPERATIONS, useValue: CATALOG },
        {
          provide: getRepositoryToken(User),
          useValue: { findOne: async ({ where }: any) => (USERS[where.id] ? structuredClone(USERS[where.id]) : null) },
        },
        { provide: LicenseService, useValue: { has: () => false } },
        { provide: OrgLicenseResolver, useValue: { entitlementsForOrg: async () => ({ entitlements }) } },
        { provide: ApisService, useValue: apis },
      ],
    }).compile();
    // structuredClone drops the entity prototype; put hasPermission back.
    const repo = module.get(getRepositoryToken(User));
    const find = repo.findOne;
    repo.findOne = async (q: any) => {
      const user = await find(q);
      if (user) user.organizationMemberships = user.organizationMemberships.map((m: any) => Object.assign(new UserOrganization(), m));
      return user;
    };
    mcp = module.get(AlmytyMcpService);
  });

  afterEach(async () => {
    await module.close();
  });

  const rpc = async (userId: string, name: string, args: any = {}) => {
    const res: any = await mcp.handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, ORG, userId);
    const text = res.result.content[0].text as string;
    return { isError: !!res.result.isError, text, json: res.result.isError ? null : JSON.parse(text) };
  };

  describe('tools/list', () => {
    it('lists the five operation tools with annotations true for every operation they run', async () => {
      const res: any = await mcp.handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ORG, 'owner');
      const byName = Object.fromEntries(res.result.tools.map((t: any) => [t.name, t.annotations]));
      expect(byName.search_operations.readOnlyHint).toBe(true);
      expect(byName.get_operation.readOnlyHint).toBe(true);
      expect(byName.call_read_operation.readOnlyHint).toBe(true);
      expect(byName.call_write_operation).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
      expect(byName.call_destructive_operation).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      // Deletes were marked destructive before; they now also say they are idempotent.
      expect(byName.delete_agent).toMatchObject({ destructiveHint: true, idempotentHint: true });
    });
  });

  describe('search_operations and get_operation', () => {
    it('finds an operation by what it does, with the tool that runs it', async () => {
      const { json } = await rpc('viewer', 'search_operations', { query: 'create widgets' });
      expect(json.operations[0]).toMatchObject({ name: 'widgets.create', effect: 'write', method: 'POST', path: '/widgets', callWith: 'call_write_operation' });
      // An operation this build does not load is not offered.
      expect(json.resources).toEqual(['gadgets', 'unguarded', 'widgets']);
    });

    it('filters by resource and effect', async () => {
      const { json } = await rpc('viewer', 'search_operations', { resource: 'widgets', effect: 'destructive' });
      expect(json.operations.map((o: any) => o.name)).toEqual(['widgets.remove']);
    });

    it('describes arguments from the DTO the route validates, and who may run it', async () => {
      const { json } = await rpc('viewer', 'get_operation', { name: 'widgets.create' });
      expect(json.requires).toEqual({ roles: ['admin', 'owner'] });
      expect(json.inputSchema.required).toEqual(['body']);
      expect(json.inputSchema.properties.body).toMatchObject({
        type: 'object',
        required: ['name'],
        additionalProperties: false,
        properties: { name: { type: 'string', maxLength: 40 }, size: { enum: ['small', 'large'] } },
      });
      expect(json.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });

      const remove = (await rpc('viewer', 'get_operation', { name: 'widgets.remove' })).json;
      expect(remove.inputSchema).toMatchObject({ required: ['id'], properties: { id: { type: 'string' } } });
      expect(remove.annotations).toMatchObject({ destructiveHint: true, idempotentHint: true });

      const list = (await rpc('viewer', 'get_operation', { name: 'widgets.list' })).json;
      expect(list.inputSchema.properties.limit).toMatchObject({ type: 'integer', minimum: 1 });

      // organizationId is never an argument: it is this organization.
      const gadgets = (await rpc('viewer', 'get_operation', { name: 'gadgets.list' })).json;
      expect(gadgets.inputSchema.properties).toEqual({});

      const premium = (await rpc('viewer', 'get_operation', { name: 'widgets.premium' })).json;
      expect(premium.requires.entitlements).toEqual(['advanced_rbac']);
    });

    it('says when an operation is unknown or not in this edition', async () => {
      expect((await rpc('owner', 'get_operation', { name: 'widgets.nope' })).text).toMatch(/Unknown operation: widgets.nope/);
      expect((await rpc('owner', 'get_operation', { name: 'ee.missing' })).text).toMatch(/not available in this edition/);
    });
  });

  describe('call_*_operation', () => {
    it('runs a write as an admin, through the route handler, validated', async () => {
      const { isError, json } = await rpc('admin', 'call_write_operation', { name: 'widgets.create', arguments: { body: { name: 'Gear', size: 'small' } } });
      expect(isError).toBe(false);
      expect(json).toEqual({ success: true, data: { id: WIDGET_ID, name: 'Gear', size: 'small' } });
      expect(calls).toEqual([{ handler: 'create', dto: expect.any(CreateWidgetDto), by: 'admin', ua: 'almyty-mcp' }]);
    });

    it('refuses a role the route refuses', async () => {
      const res = await rpc('member', 'call_write_operation', { name: 'widgets.create', arguments: { body: { name: 'Gear' } } });
      expect(res).toMatchObject({ isError: true });
      expect(res.text).toMatch(/Insufficient role privileges/);
      expect(calls).toEqual([]);
    });

    it('refuses someone who is not a member of this organization', async () => {
      const res = await rpc('outsider', 'call_read_operation', { name: 'widgets.list' });
      expect(res.text).toMatch(/not a member of this organization/);
      expect(calls).toEqual([]);
    });

    it('refuses a revoked membership and a deactivated user', async () => {
      expect((await rpc('revoked', 'call_read_operation', { name: 'widgets.list' })).text).toMatch(/not a member/);
      expect((await rpc('disabled', 'call_read_operation', { name: 'widgets.list' })).text).toMatch(/inactive/);
      expect((await rpc('', 'call_read_operation', { name: 'widgets.list' })).text).toMatch(/signed-in user/);
    });

    it('lets a viewer read, with query values typed as the DTO says', async () => {
      const { json } = await rpc('viewer', 'call_read_operation', { name: 'widgets.list', arguments: { limit: 5 } });
      expect(json).toMatchObject({ limit: 5 });
      expect(calls[0]).toMatchObject({ handler: 'list', org: ORG });
    });

    it('refuses fields the DTO does not declare and values it does not allow', async () => {
      const extra = await rpc('owner', 'call_write_operation', { name: 'widgets.create', arguments: { body: { name: 'Gear', color: 'red' } } });
      expect(extra.text).toMatch(/property color should not exist/);
      const bad = await rpc('owner', 'call_write_operation', { name: 'widgets.create', arguments: { body: { name: 'Gear', size: 'huge' } } });
      expect(bad.text).toMatch(/size must be one of/);
      expect(calls).toEqual([]);
    });

    it('runs a destructive operation only through call_destructive_operation', async () => {
      const wrong = await rpc('owner', 'call_write_operation', { name: 'widgets.remove', arguments: { id: WIDGET_ID } });
      expect(wrong.text).toMatch(/widgets.remove is a destructive operation; run it with call_destructive_operation/);
      const read = await rpc('owner', 'call_read_operation', { name: 'widgets.create', arguments: { body: { name: 'x' } } });
      expect(read.text).toMatch(/run it with call_write_operation/);
      expect(calls).toEqual([]);

      const { json } = await rpc('owner', 'call_destructive_operation', { name: 'widgets.remove', arguments: { id: WIDGET_ID } });
      expect(json).toEqual({ success: true, deleted: WIDGET_ID });
    });

    it('applies the route\'s parameter pipes and needs its path parameters', async () => {
      expect((await rpc('owner', 'call_destructive_operation', { name: 'widgets.remove', arguments: { id: 'not-a-uuid' } })).text).toMatch(/uuid is expected/);
      expect((await rpc('owner', 'call_destructive_operation', { name: 'widgets.remove', arguments: {} })).text).toMatch(/Missing argument: id/);
    });

    it('refuses an enterprise operation without the entitlement, and runs it with one', async () => {
      const refused = await rpc('member', 'call_read_operation', { name: 'widgets.premium' });
      expect(refused.text).toMatch(/requires an enterprise license entitlement: advanced_rbac/);
      entitlements = ['advanced_rbac'];
      expect((await rpc('member', 'call_read_operation', { name: 'widgets.premium' })).json).toEqual({ success: true, premium: true });
    });

    it('answers for this organization whatever organizationId the caller passes', async () => {
      const { json } = await rpc('member', 'call_read_operation', { name: 'gadgets.list', arguments: { organizationId: OTHER_ORG } });
      expect(json).toEqual({ organizationId: ORG });
    });

    it('never runs a public route or one without the user guard', async () => {
      expect((await rpc('owner', 'call_read_operation', { name: 'widgets.open' })).text).toMatch(/not for a signed-in user/);
      expect((await rpc('owner', 'call_read_operation', { name: 'unguarded.list' })).text).toMatch(/not for a signed-in user/);
    });

    it('runs a route whose upload is optional in its JSON form, and refuses any other interceptor', async () => {
      const { json } = await rpc('member', 'call_write_operation', { name: 'widgets.import', arguments: { body: { url: 'https://example.com/spec.json' } } });
      expect(json).toEqual({ success: true, url: 'https://example.com/spec.json', file: null });
      expect((await rpc('member', 'call_read_operation', { name: 'widgets.traced' })).text).toMatch(/cannot reproduce/);
    });

    it('refuses a secret at any depth before the route runs, naming where it was and the app page instead', async () => {
      for (const body of [
        { name: 'Gear', apiKey: 'sk-live' },
        { name: 'Gear', headers: { Authorization: 'Bearer live' } },
        { name: 'Gear', auth: { config: { clientSecret: 's' } } },
        { name: 'Gear', items: [{ password: 'p' }] },
      ]) {
        const res = await rpc('admin', 'call_write_operation', { name: 'widgets.create', arguments: { body } });
        expect(res.isError).toBe(true);
        expect(res.text).toContain('does not take secrets over MCP');
        expect(res.text).toContain('/credentials/new');
        expect(res.text).not.toMatch(/sk-live|Bearer live/);
      }
      expect(calls).toEqual([]);
    });

    it('lets an empty secret-named field through to the route\'s own validation', async () => {
      const res = await rpc('admin', 'call_write_operation', { name: 'widgets.create', arguments: { body: { name: 'Gear', token: '' } } });
      expect(res.text).not.toContain('does not take secrets');
      expect(res.isError).toBe(true); // forbidNonWhitelisted: CreateWidgetDto has no token
    });

    it('answers an operation that takes a secret with the app page, without running anything', async () => {
      const res = await rpc('admin', 'call_write_operation', { name: 'credentials.rotate', arguments: { id: WIDGET_ID } });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('takes a secret');
      expect(res.text).toContain(`/credentials/${WIDGET_ID}`);
      const described = await rpc('admin', 'get_operation', { name: 'credentials.add' });
      expect(described.text).toContain('/credentials/new');
    });

    it('tells an unexpected failure the way the REST error filter does, without its detail', async () => {
      const res = await rpc('owner', 'call_read_operation', { name: 'widgets.broken' });
      expect(res.text).toBe('Error: Internal server error');
    });
  });

  describe('curated tools answer to their REST twin', () => {
    // delete_api mirrors DELETE /apis/:id, which is admin and owner only.
    it('refuses a member the dashboard would refuse, before the service runs', async () => {
      const res = await rpc('member', 'delete_api', { apiId: WIDGET_ID });
      expect(res.text).toMatch(/Insufficient role privileges/);
      expect(apis.remove).not.toHaveBeenCalled();
    });

    it('refuses a caller from another organization', async () => {
      const res = await rpc('outsider', 'delete_api', { apiId: WIDGET_ID });
      expect(res.text).toMatch(/not a member of this organization/);
      expect(apis.remove).not.toHaveBeenCalled();
    });

    it('lets an admin through to the tool', async () => {
      const res = await rpc('admin', 'delete_api', { apiId: WIDGET_ID });
      expect(res.json).toEqual({ deleted: true, apiId: WIDGET_ID });
      expect(apis.remove).toHaveBeenCalled();
    });
  });
});
