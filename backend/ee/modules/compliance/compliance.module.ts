import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CompliancePolicy } from '../../../src/entities/compliance-policy.entity';
import { AuditLog } from '../../../src/entities/audit-log.entity';
import { COMPLIANCE_ENFORCEMENT_HOOK } from '../../../src/common/ee-hooks/ee-hooks';

import { ComplianceService } from './compliance.service';
import { ComplianceEnforcementHookImpl } from './compliance-enforcement.hook';
import { ComplianceController } from './compliance.controller';

/**
 * EE (compliance_pack): enforced org-policy layer over the OSS built-in
 * pii-filter + security-scanner plugins, plus audit-derived reporting.
 * Controller-gated by `EntitlementGuard`.
 *
 * `@Global()` so the `COMPLIANCE_ENFORCEMENT_HOOK` binding is resolvable
 * by the core PluginManagerService's `@Optional()` injection without the
 * core importing anything from `ee/`.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([CompliancePolicy, AuditLog])],
  providers: [
    ComplianceService,
    ComplianceEnforcementHookImpl,
    { provide: COMPLIANCE_ENFORCEMENT_HOOK, useExisting: ComplianceEnforcementHookImpl },
  ],
  controllers: [ComplianceController],
  exports: [ComplianceService, COMPLIANCE_ENFORCEMENT_HOOK],
})
export class ComplianceModule {}