import { Global, Module } from '@nestjs/common';
import { LicenseService } from './license.service';
import { EntitlementGuard } from './guards/entitlement.guard';
import { LicensingController } from './licensing.controller';

/**
 * Global so `LicenseService` and `EntitlementGuard` are injectable from any
 * module (SSO, RBAC, audit-export, etc.) without re-importing.
 */
@Global()
@Module({
  controllers: [LicensingController],
  providers: [LicenseService, EntitlementGuard],
  exports: [LicenseService, EntitlementGuard],
})
export class LicensingModule {}
