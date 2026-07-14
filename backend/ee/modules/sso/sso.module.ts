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
import { ScimService } from './scim.service';
import { ScimAuthGuard } from './guards/scim-auth.guard';
import { SsoController } from './sso.controller';
import { SsoConfigController } from './sso-config.controller';
import { ScimController } from './scim.controller';

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
  ],
  providers: [SsoConfigService, SsoService, ScimService, ScimAuthGuard],
  controllers: [SsoConfigController, SsoController, ScimController],
  exports: [SsoConfigService],
})
export class SsoModule {}
