import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CompliancePolicy } from '../../../src/entities/compliance-policy.entity';
import { AuditLog } from '../../../src/entities/audit-log.entity';

import { ComplianceService } from './compliance.service';
import { ComplianceController } from './compliance.controller';

/**
 * EE (compliance_pack): enforced org-policy layer over the OSS built-in
 * pii-filter + security-scanner plugins, plus audit-derived reporting.
 * Controller-gated by `EntitlementGuard`; exports the service so the
 * plugin runtime can consult the effective policy.
 */
@Module({
  imports: [TypeOrmModule.forFeature([CompliancePolicy, AuditLog])],
  providers: [ComplianceService],
  controllers: [ComplianceController],
  exports: [ComplianceService],
})
export class ComplianceModule {}
