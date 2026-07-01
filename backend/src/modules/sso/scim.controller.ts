import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Req,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Request } from 'express';

import { Public } from '../../common/decorators/public.decorator';
import { EntitlementGuard } from '../licensing/guards/entitlement.guard';
import { RequiresEntitlement } from '../licensing/decorators/requires-entitlement.decorator';
import { EE_ENTITLEMENTS } from '../licensing/license.constants';
import { ScimAuthGuard } from './guards/scim-auth.guard';
import {
  ScimService,
  ScimUserInput,
  ScimGroupInput,
  ScimPatchOp,
} from './scim.service';

/**
 * SCIM 2.0 provisioning (T4.2). Authenticated by the per-org bearer token
 * (ScimAuthGuard resolves it to `req.scimOrgId`), and gated by the `sso`
 * entitlement — EntitlementGuard runs first, so an unlicensed deployment
 * returns 402 before any token check.
 *
 * `@Public` opts out of the app's JWT auth: SCIM clients (Okta/Entra) present
 * their own bearer token, not a user JWT.
 */
@ApiTags('SCIM')
@Controller('scim/v2')
@Public()
@UseGuards(EntitlementGuard, ScimAuthGuard)
@RequiresEntitlement(EE_ENTITLEMENTS.SSO)
export class ScimController {
  constructor(private readonly scim: ScimService) {}

  private orgId(req: Request): string {
    return (req as any).scimOrgId;
  }

  // ── Users ─────────────────────────────────────────────────────────

  @Post('Users')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Provision a user' })
  createUser(@Req() req: Request, @Body() body: ScimUserInput) {
    return this.scim.createUser(this.orgId(req), body);
  }

  @Get('Users')
  @ApiOperation({ summary: 'List / filter users' })
  listUsers(@Req() req: Request, @Query('filter') filter?: string) {
    return this.scim.listUsers(this.orgId(req), filter);
  }

  @Get('Users/:id')
  @ApiOperation({ summary: 'Get a user' })
  getUser(@Req() req: Request, @Param('id') id: string) {
    return this.scim.getUser(this.orgId(req), id);
  }

  @Put('Users/:id')
  @ApiOperation({ summary: 'Replace a user' })
  replaceUser(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: ScimUserInput,
  ) {
    return this.scim.replaceUser(this.orgId(req), id, body);
  }

  @Patch('Users/:id')
  @ApiOperation({ summary: 'Patch a user (e.g. deactivate)' })
  patchUser(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: ScimPatchOp,
  ) {
    return this.scim.patchUser(this.orgId(req), id, body);
  }

  @Delete('Users/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Deprovision a user' })
  async deleteUser(@Req() req: Request, @Param('id') id: string) {
    await this.scim.deleteUser(this.orgId(req), id);
  }

  // ── Groups ────────────────────────────────────────────────────────

  @Post('Groups')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Provision a group' })
  createGroup(@Req() req: Request, @Body() body: ScimGroupInput) {
    return this.scim.createGroup(this.orgId(req), body);
  }

  @Get('Groups')
  @ApiOperation({ summary: 'List groups' })
  listGroups(@Req() req: Request) {
    return this.scim.listGroups(this.orgId(req));
  }

  @Get('Groups/:id')
  @ApiOperation({ summary: 'Get a group' })
  getGroup(@Req() req: Request, @Param('id') id: string) {
    return this.scim.getGroup(this.orgId(req), id);
  }

  @Patch('Groups/:id')
  @ApiOperation({ summary: 'Patch a group (membership changes)' })
  patchGroup(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: ScimPatchOp,
  ) {
    return this.scim.patchGroup(this.orgId(req), id, body);
  }

  @Delete('Groups/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a group' })
  async deleteGroup(@Req() req: Request, @Param('id') id: string) {
    await this.scim.deleteGroup(this.orgId(req), id);
  }
}
