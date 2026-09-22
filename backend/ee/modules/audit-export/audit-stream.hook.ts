import { Injectable } from '@nestjs/common';

import { AuditStreamHook } from '../../../src/common/ee-hooks/ee-hooks';
import { AuditLog } from '../../../src/entities/audit-log.entity';
import { OrgLicenseResolver } from '../../../src/modules/licensing/org-license.resolver';
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
    private readonly licenses: OrgLicenseResolver,
  ) {}

  /**
   * Per-organization, not per-process.
   *
   * Licensing in this product is org-scoped: tokens are minted per org
   * by billing, EntitlementGuard resolves per org, and
   * /licensing/entitlements answers for the requesting org. This hook
   * checked LicenseService -- the process-global singleton, which is
   * community unless ALMYTY_LICENSE_KEY/TOKEN is in the environment.
   * The deployed API sets only the license SIGNING key, so has()
   * returned false for every entitlement, forever: a Business or
   * Enterprise org could reach the settings screen, configure the
   * feature, be told it saved, and have it do nothing at run time.
   */
  private async licensed(organizationId: string, key: string): Promise<boolean> {
    try {
      return await this.licenses.hasForOrg(organizationId, key);
    } catch {
      return false;
    }
  }

  async afterAuditWrite(event: AuditLog): Promise<void> {
    // The audit row carries the org it belongs to.
    if (!(await this.licensed(event.organizationId, EE_ENTITLEMENTS.AUDIT_EXPORT))) return;
    await this.streams.dispatch(event);
  }
}
