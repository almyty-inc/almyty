import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditLog } from '../../../src/entities/audit-log.entity';
import { AuditStreamConfig } from '../../../src/entities/audit-stream-config.entity';
import { AUDIT_STREAM_HOOK } from '../../../src/common/ee-hooks/ee-hooks';

import { AuditExportService } from './audit-export.service';
import { AuditStreamService } from './audit-stream.service';
import { AuditStreamHookImpl } from './audit-stream.hook';
import { AuditExportController } from './audit-export.controller';

/**
 * EE (audit_export): bulk export + SIEM streaming. The OSS AuditLogModule
 * still owns writes and in-app queries; this module adds the enterprise
 * egress paths, all gated by `EntitlementGuard` at the controller.
 *
 * `@Global()` so the `AUDIT_STREAM_HOOK` binding is resolvable by the core
 * AuditLogService's `@Optional()` injection without the core importing
 * anything from `ee/`.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AuditLog, AuditStreamConfig])],
  providers: [
    AuditExportService,
    AuditStreamService,
    AuditStreamHookImpl,
    { provide: AUDIT_STREAM_HOOK, useExisting: AuditStreamHookImpl },
  ],
  controllers: [AuditExportController],
  exports: [AuditExportService, AuditStreamService, AUDIT_STREAM_HOOK],
})
export class AuditExportModule {}