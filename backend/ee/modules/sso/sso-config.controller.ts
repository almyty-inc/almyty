import {
  Controller,
  Get,
  Put,
  Post,
  Delete,
  Body,
  Param,
  ParseUUIDPipe,
  HttpCode,
  Req,
  UseGuards,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Request } from 'express';

import { JwtAuthGuard } from '../../../src/modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../src/modules/auth/guards/roles.guard';
import { Roles } from '../../../src/modules/auth/decorators/roles.decorator';
import { EntitlementGuard } from '../../../src/modules/licensing/guards/entitlement.guard';
import { RequiresEntitlement } from '../../../src/modules/licensing/decorators/requires-entitlement.decorator';
import { EE_ENTITLEMENTS } from '../../../src/modules/licensing/license.constants';
import { SsoConfigService, UpsertSsoConfigDto } from './sso-config.service';
import { OrgDomainService } from './org-domain.service';
import { publicBaseUrl } from './sso.util';

/**
 * Org-admin SSO configuration (T4.3). Every route is gated by the `sso`
 * entitlement (EntitlementGuard → 402 in the community build) and restricted
 * to owner/admin via RolesGuard. Mounted at `/sso/settings` — distinct from the
 * `/sso/:orgId/...` login routes so the two never collide.
 */
@ApiTags('SSO')
@ApiBearerAuth()
@Controller('sso/settings')
@UseGuards(JwtAuthGuard, RolesGuard, EntitlementGuard)
@RequiresEntitlement(EE_ENTITLEMENTS.SSO)
export class SsoConfigController {
  constructor(
    private readonly configService: SsoConfigService,
    private readonly domains: OrgDomainService,
  ) {}

  private orgId(req: Request): string {
    const organizationId = (req as any).user?.currentOrganizationId;
    if (!organizationId) {
      throw new HttpException(
        {
          success: false,
          message:
            'Organization context required. Multi-org users must send the X-Organization-Id header.',
          error: 'NO_ORGANIZATION',
        },
        HttpStatus.BAD_REQUEST,
      );
    }
    return organizationId;
  }

  @Get()
  @Roles('owner', 'admin')
  @ApiOperation({ summary: 'Get the org SSO/SCIM configuration (secrets masked)' })
  async get(@Req() req: Request) {
    const orgId = this.orgId(req);
    const config = await this.configService.get(orgId);
    return {
      success: true,
      data: this.configService.toPublicView(config, publicBaseUrl(req)),
    };
  }

  @Put()
  @Roles('owner', 'admin')
  @ApiOperation({ summary: 'Create or update the org SSO configuration' })
  async upsert(@Req() req: Request, @Body() body: UpsertSsoConfigDto) {
    const orgId = this.orgId(req);
    const config = await this.configService.upsert(orgId, body);
    return {
      success: true,
      data: this.configService.toPublicView(config, publicBaseUrl(req)),
    };
  }

  @Post('scim-token')
  @Roles('owner', 'admin')
  @ApiOperation({ summary: 'Rotate the SCIM bearer token (returned once)' })
  async rotateScimToken(@Req() req: Request) {
    const orgId = this.orgId(req);
    const { token } = await this.configService.rotateScimToken(orgId);
    return {
      success: true,
      data: { token, scimBaseUrl: `${publicBaseUrl(req)}/scim/v2` },
      message: 'Copy this token now — it will not be shown in full again.',
    };
  }

  @Get('scim-token')
  @Roles('owner', 'admin')
  @ApiOperation({ summary: 'Reveal the current SCIM bearer token' })
  async revealScimToken(@Req() req: Request) {
    const orgId = this.orgId(req);
    const token = await this.configService.revealScimToken(orgId);
    return {
      success: true,
      data: { token, scimBaseUrl: `${publicBaseUrl(req)}/scim/v2` },
    };
  }

  // ── Verified email domains (SSO provisions only these) ─────────────

  @Get('domains')
  @Roles('owner', 'admin')
  @ApiOperation({ summary: "List the organization's email domains and their verification records" })
  async listDomains(@Req() req: Request) {
    return { success: true, data: await this.domains.list(this.orgId(req)) };
  }

  @Post('domains')
  @Roles('owner', 'admin')
  @ApiOperation({ summary: 'Add an email domain; it counts once its DNS TXT record is verified' })
  async addDomain(@Req() req: Request, @Body() body: { domain?: unknown }) {
    return { success: true, data: await this.domains.add(this.orgId(req), body?.domain) };
  }

  @Post('domains/:id/verify')
  @HttpCode(200)
  @Roles('owner', 'admin')
  @ApiOperation({ summary: "Check a domain's DNS TXT record" })
  async verifyDomain(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return { success: true, data: await this.domains.verify(this.orgId(req), id) };
  }

  @Delete('domains/:id')
  @Roles('owner', 'admin')
  @ApiOperation({ summary: 'Remove an email domain' })
  async removeDomain(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    await this.domains.remove(this.orgId(req), id);
    return { success: true };
  }
}