/**
 * Enterprise (EE) module barrel — the ONLY entry point the core build
 * dynamically loads (via `src/ee-loader.ts`). Everything under `ee/` is
 * commercially licensed (see ee/LICENSE) and is excluded from the OSS
 * (Apache-2.0) build. The core app boots identically with or without this
 * tree present: when it is absent the loader resolves to `[]`.
 *
 * One-way dependency only: `ee/ → src/` (entities, licensing guard, auth).
 * Nothing in `src/` may import from `ee/` at build time.
 */
import { SsoModule } from './modules/sso/sso.module';
import { RbacModule } from './modules/rbac/rbac.module';
import { AuditExportModule } from './modules/audit-export/audit-export.module';
import { ApprovalPoliciesModule } from './modules/approval-policies/approval-policies.module';
import { BillingModule } from './modules/billing/billing.module';
import { EeStubsModule } from './modules/ee-stubs/ee-stubs.module';
import { ComplianceModule } from './modules/compliance/compliance.module';
import { ChargebackModule } from './modules/chargeback/chargeback.module';

/** Every EE feature module, in the order the app should register them. */
export const EE_MODULES = [
  SsoModule,
  RbacModule,
  AuditExportModule,
  ApprovalPoliciesModule,
  BillingModule,
  EeStubsModule,
  ComplianceModule,
  ChargebackModule,
];
