import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Organization } from '../../entities/organization.entity';
import { LicenseService } from './license.service';
import { OrgLicenseResolver } from './org-license.resolver';
import { EntitlementGuard } from './guards/entitlement.guard';
import { LicensingController } from './licensing.controller';

/**
 * Global so `LicenseService`, `OrgLicenseResolver`, and `EntitlementGuard` are
 * injectable from any module (SSO, RBAC, audit-export, etc.) without
 * re-importing.
 *
 * `TypeOrmModule.forFeature([Organization])` registers only the Organization
 * REPOSITORY as a data dependency for `OrgLicenseResolver` — it does NOT import
 * `OrganizationsModule`/`BillingModule`, so no new module edge into licensing's
 * dependents is created and the EE require-cycle stays broken.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Organization])],
  controllers: [LicensingController],
  providers: [LicenseService, OrgLicenseResolver, EntitlementGuard],
  exports: [LicenseService, OrgLicenseResolver, EntitlementGuard],
})
export class LicensingModule {}
