import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { OrgSsoConfig } from '../../../src/entities/org-sso-config.entity';
import { User } from '../../../src/entities/user.entity';
import { UserOrganization } from '../../../src/entities/user-organization.entity';
import { Team } from '../../../src/entities/team.entity';
import { UserTeam } from '../../../src/entities/user-team.entity';

import { AuthModule } from '../../../src/modules/auth/auth.module';
import { SsoConfigService } from './sso-config.service';
import { SsoService } from './sso.service';
import { OidcLoginStateStoreFactory } from './oidc-login-state.store';
import { SamlReplayCache } from './saml-replay-cache';
import { ScimService } from './scim.service';
import { ScimAuthGuard } from './guards/scim-auth.guard';
import { SsoController } from './sso.controller';
import { SsoConfigController } from './sso-config.controller';
import { ScimController } from './scim.controller';
import { HostedChatSsoController } from './hosted-chat-sso.controller';
import { HostedChatSsoSettingsController } from './hosted-chat-sso-settings.controller';
import { GatewaysModule } from '../../../src/modules/gateways/gateways.module';
import { ConnectionsModule } from '../../../src/modules/connections/connections.module';


/**
 * Enterprise SSO (SAML/OIDC) + SCIM provisioning (P4). Every route is gated by
 * the `sso` entitlement, so this module is inert in the community build. Relies
 * on the @Global LicensingModule for LicenseService/EntitlementGuard and
 * imports AuthModule to reuse the app's JWT issuance + guards.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([OrgSsoConfig, User, UserOrganization, Team, UserTeam]),
    AuthModule,
    GatewaysModule,
    // SCIM deprovisioning wipes and provider-revokes the member's own connections.
    ConnectionsModule,
  ],

  providers: [SsoConfigService, SsoService, SamlReplayCache, OidcLoginStateStoreFactory, ScimService, ScimAuthGuard],
  controllers: [SsoConfigController, SsoController, ScimController, HostedChatSsoController, HostedChatSsoSettingsController],
  exports: [SsoConfigService, ScimService],
})
export class SsoModule {}
