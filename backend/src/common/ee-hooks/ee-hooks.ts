import { AuditLog } from '../../entities/audit-log.entity';

/**
 * Optional EE runtime hook points.
 *
 * The core defines the injection tokens + interfaces; the commercial `ee/`
 * tree provides the implementations (bound to these tokens in `@Global()` EE
 * modules loaded via `loadEeModules()`). Core consumers inject every token
 * `@Optional()` — in a community build (no `ee/` tree) the token resolves to
 * `undefined` and the consumer keeps its exact OSS behavior.
 *
 * Two invariants every implementation must uphold:
 *   1. Entitlement check at call time (`LicenseService.has(...)`): an EE
 *      build without a valid license behaves exactly like community.
 *   2. Never let a hook failure break the core flow — consumers additionally
 *      guard each call, but implementations should stay best-effort.
 *
 * The one-way dependency rule is preserved: `src/` only knows these
 * interfaces; nothing here (or in the consumers) imports from `ee/`.
 */

// ── Audit → SIEM streaming (entitlement: audit_export) ──

export const AUDIT_STREAM_HOOK = 'EE_AUDIT_STREAM_HOOK';

export interface AuditStreamHook {
  /**
   * Called after an audit row is persisted. Fire-and-forget from the
   * caller's perspective — delivery failures must never propagate.
   */
  afterAuditWrite(event: AuditLog): Promise<void> | void;
}

// ── Approval policies (entitlement: approval_policy) ──

export const APPROVAL_POLICY_HOOK = 'EE_APPROVAL_POLICY_HOOK';

/** Reference to the policy governing an approval request. */
export interface ApprovalPolicyRef {
  id: string;
  name: string;
}

/** One approval already collected for a policy-governed request. */
export interface ApprovalPolicyApproval {
  approverId: string;
  /** Role names the approver held when approving (org role, team role, ...). */
  roles: string[];
}

export interface ApprovalPolicyStepProgress {
  index: number;
  name: string;
  approverRole: string;
  required: number;
  satisfiedBy: number;
  satisfied: boolean;
}

export interface ApprovalPolicyProgress {
  policyId: string;
  policyName: string;
  totalRequired: number;
  totalCollected: number;
  steps: ApprovalPolicyStepProgress[];
  /** Index of the first not-yet-satisfied step, or -1 when complete. */
  currentStep: number;
  satisfied: boolean;
}

export interface ApprovalPolicyHook {
  /**
   * Which policy (if any) governs a new approval request. `null` means no
   * policy matched (or the deployment is unlicensed) — the caller applies
   * the OSS single-gate flow.
   */
  resolveForContext(
    organizationId: string,
    ctx: Record<string, unknown>,
  ): Promise<ApprovalPolicyRef | null>;

  /**
   * Score the approvals collected so far against the governing policy.
   * `null` means the policy no longer exists or the deployment is
   * unlicensed — the caller falls back to the OSS single-gate flow.
   */
  scoreProgress(
    organizationId: string,
    policyId: string,
    approvals: ApprovalPolicyApproval[],
  ): Promise<ApprovalPolicyProgress | null>;
}

// ── Custom RBAC / ABAC (entitlement: advanced_rbac) ──

export const ADVANCED_RBAC_HOOK = 'EE_ADVANCED_RBAC_HOOK';

export type RbacHookEffect = 'allow' | 'deny' | 'abstain';

export interface RbacHookDecision {
  effect: RbacHookEffect;
  reason?: string;
}

export interface AdvancedRbacHook {
  /**
   * Additive grants: do the user's custom-role permissions cover
   * `permission`? Must return `false` when unlicensed.
   */
  hasPermission(
    organizationId: string,
    userId: string,
    permission: string,
  ): Promise<boolean>;

  /**
   * ABAC evaluation for deny-overrides. 'abstain' when no policy applies
   * (or unlicensed) so the built-in decision stands unchanged.
   */
  evaluateAccess(
    organizationId: string,
    action: string,
    ctx: {
      subject?: Record<string, unknown>;
      resource?: Record<string, unknown>;
      context?: Record<string, unknown>;
    },
  ): Promise<RbacHookDecision>;
}

// ── Compliance enforcement (entitlement: compliance_pack) ──

export const COMPLIANCE_ENFORCEMENT_HOOK = 'EE_COMPLIANCE_ENFORCEMENT_HOOK';

export interface ComplianceEnforcement {
  /**
   * Plugin key (slug of the plugin name, e.g. 'pii-filter',
   * 'security-scanner') → settings overrides to apply when force-running
   * the plugin. An entry means the plugin is enforced org-wide even when
   * not individually enabled.
   */
  enforcedPlugins: Record<string, Record<string, any>>;
  blockOnViolation: boolean;
}

export interface ComplianceEnforcementHook {
  /**
   * Effective org-wide plugin enforcement. `null` when nothing is
   * enforced (or the deployment is unlicensed).
   */
  getEnforcement(organizationId: string): Promise<ComplianceEnforcement | null>;
}
