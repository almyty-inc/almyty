import { Injectable } from '@nestjs/common';

import { AuditStreamHook } from '../../../src/common/ee-hooks/ee-hooks';
import { AuditLog } from '../../../src/entities/audit-log.entity';
import { LicenseService } from '../../../src/modules/licensing/license.service';
import { EE_ENTITLEMENTS } from '../../../src/modules/licensing/license.constants';

import { AuditStreamService } from './audit-stream.service';

/**
 * EE (audit_export): runtime bridge bound to the core `AUDIT_STREAM_HOOK`
 * token. The core AuditLogService calls it (fire-and-forget) after every
 * audit write; we forward the event to the org's configured SIEM targets.
 *
 * Entitlement is checked per call — an EE build without a valid license
 * behaves exactly like community (no dispatch, no DB reads).
 */
@Injectable()
export class AuditStreamHookImpl implements AuditStreamHook {
  constructor(
    private readonly streams: AuditStreamService,
    private readonly license: LicenseService,
  ) {}

  async afterAuditWrite(event: AuditLog): Promise<void> {
    if (!this.license.has(EE_ENTITLEMENTS.AUDIT_EXPORT)) return;
    await this.streams.dispatch(event);
  }
}
