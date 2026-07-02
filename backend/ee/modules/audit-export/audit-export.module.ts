import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditLog } from '../../../src/entities/audit-log.entity';
import { AuditStreamConfig } from '../../../src/entities/audit-stream-config.entity';

import { AuditExportService } from './audit-export.service';
import { AuditStreamService } from './audit-stream.service';
import { AuditExportController } from './audit-export.controller';

/**
 * EE (audit_export): bulk export + SIEM streaming. The OSS AuditLogModule
 * still owns writes and in-app queries; this module adds the enterprise
 * egress paths, all gated by `EntitlementGuard` at the controller.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AuditLog, AuditStreamConfig])],
  providers: [AuditExportService, AuditStreamService],
  controllers: [AuditExportController],
  exports: [AuditExportService, AuditStreamService],
})
export class AuditExportModule {}
