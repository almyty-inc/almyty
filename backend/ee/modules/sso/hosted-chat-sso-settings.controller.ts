import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../../src/modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../src/modules/auth/guards/roles.guard';
import { Roles } from '../../../src/modules/auth/decorators/roles.decorator';
import { EntitlementGuard } from '../../../src/modules/licensing/guards/entitlement.guard';
import { RequiresEntitlement } from '../../../src/modules/licensing/decorators/requires-entitlement.decorator';
import { EE_ENTITLEMENTS } from '../../../src/modules/licensing/license.constants';
import { GatewayType } from '../../../src/entities/gateway.entity';
import { GatewaysService } from '../../../src/modules/gateways/gateways.service';
import { hostedChatConfigFrom } from '../../../src/modules/gateways/channels/hosted-chat.config';
import { HostedChatSsoController } from './hosted-chat-sso.controller';
import { SsoService } from './sso.service';

export interface HostedChatSsoUrls {
  /** The organization's SSO protocol, or null when SSO is not set up. */
  protocol: 'saml' | 'oidc' | null;
  /** The ACS URLs to register at a SAML IdP, one per host the chat is served on. */
  samlAcsUrls: string[];
  /** The redirect URI to register at an OIDC IdP. */
  oidcRedirectUri: string | null;
}

/**
 * What an organization registers at its identity provider so hosted-chat
 * visitors can sign in with SSO, shown inline on the gateway page. Built by
 * the same HostedChatSsoController functions the sign-in routes use, never
 * rebuilt in the frontend, so the copied URL is the one the IdP is sent.
 */
@Controller('gateways')
@ApiTags('Gateways')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, EntitlementGuard)
@RequiresEntitlement(EE_ENTITLEMENTS.SSO)
export class HostedChatSsoSettingsController {
  constructor(
    private readonly gateways: GatewaysService,
    private readonly sso: SsoService,
  ) {}

  @Get(':gatewayId/hosted-chat-sso')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'The URLs to register at the IdP for hosted chat SSO visitor sign-in' })
  async get(
    @Param('gatewayId', ParseUUIDPipe) gatewayId: string,
    @Req() req: any,
  ): Promise<{ success: true; data: HostedChatSsoUrls }> {
    const organizationId = req?.user?.currentOrganizationId;
    if (!organizationId) throw new BadRequestException('Organization context required. Send X-Organization-Id.');
    // Same lookup the other hosted-chat settings use: org-scoped, and
    // another member's private gateway does not exist.
    const gateway = await this.gateways.findManageable(gatewayId, organizationId, req.user.id);
    if (gateway.type !== GatewayType.HOSTED_CHAT) {
      throw new BadRequestException({ code: 'NOT_A_HOSTED_CHAT', message: 'Visitor sign-in is for hosted chat apps.' });
    }
    const slug = hostedChatConfigFrom(gateway.configuration).slug;
    return {
      success: true,
      data: {
        protocol: await this.sso.protocolFor(organizationId),
        samlAcsUrls: slug ? HostedChatSsoController.samlAcsUrls(gateway, slug) : [],
        oidcRedirectUri: slug ? HostedChatSsoController.callbackUrl(slug) : null,
      },
    };
  }
}
