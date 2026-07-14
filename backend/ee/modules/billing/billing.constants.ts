/**
 * Hosted-subscription billing constants (P6). This is the COMMERCIAL side of the
 * open-core split: it charges customers for the hosted almyty subscription and,
 * on payment, mints the same Ed25519 entitlement token the OSS licensing module
 * verifies. It is NOT the OSS spend-governance surface (P2), which governs a
 * user's own LLM keys.
 */
import { EE_ENTITLEMENTS } from '../../../src/modules/licensing/license.constants';

/** Stripe secret API key (server secret). Absent → billing disabled. */
export const STRIPE_SECRET_KEY_ENV = 'STRIPE_SECRET_KEY';

/** Stripe webhook signing secret (whsec_...). Required to verify webhooks. */
export const STRIPE_WEBHOOK_SECRET_ENV = 'STRIPE_WEBHOOK_SECRET';

/**
 * Ed25519 PRIVATE key (PEM or base64 PEM) used to SIGN entitlement tokens on
 * successful payment. This is a vendor secret held only by the hosted control
 * plane — never shipped in the OSS build. The matching PUBLIC key is what the
 * licensing module verifies with.
 */
export const LICENSE_PRIVATE_KEY_ENV = 'ALMYTY_LICENSE_PRIVATE_KEY';

/**
 * Stripe price ids for the SELF-SERVE plans (per-seat). Enterprise is
 * deliberately NOT a self-serve price — it is a contact-sales/custom deal
 * (SCIM, SLAs, security review, volume commitments are negotiated), matching
 * almyty.com/pricing. There is no STRIPE_PRICE_ENTERPRISE.
 */
export const STRIPE_PRICE_PRO_ENV = 'STRIPE_PRICE_PRO';
export const STRIPE_PRICE_BUSINESS_ENV = 'STRIPE_PRICE_BUSINESS';

/** Post-checkout / portal redirect targets. */
export const STRIPE_CHECKOUT_SUCCESS_URL_ENV = 'STRIPE_CHECKOUT_SUCCESS_URL';
export const STRIPE_CHECKOUT_CANCEL_URL_ENV = 'STRIPE_CHECKOUT_CANCEL_URL';
export const STRIPE_PORTAL_RETURN_URL_ENV = 'STRIPE_PORTAL_RETURN_URL';

/** Days a subscription keeps its entitlements after a failed payment. */
export const DUNNING_GRACE_DAYS_ENV = 'BILLING_DUNNING_GRACE_DAYS';
export const DEFAULT_DUNNING_GRACE_DAYS = 7;

export const PLAN_FREE = 'free';
export const PLAN_PRO = 'pro';
export const PLAN_BUSINESS = 'business';
export const PLAN_ENTERPRISE = 'enterprise';

/** Plans customers can self-serve via Stripe checkout. Enterprise is
 *  contact-sales only. */
export const SELF_SERVE_PLANS = [PLAN_PRO, PLAN_BUSINESS];
export const PAID_PLANS = [PLAN_PRO, PLAN_BUSINESS, PLAN_ENTERPRISE];

/**
 * Plan → EE entitlement set minted into the signed license token. `free` grants
 * nothing beyond the community baseline (the token is revoked on downgrade). The
 * community entitlements are always unioned in by `LicenseService` itself.
 */
export const PLAN_ENTITLEMENTS: Record<string, string[]> = {
  // Free = community baseline (agents/tools/gateways/MCP/memory/runner/basic
  // audit/basic RBAC/spend governance) — unioned in by LicenseService.
  [PLAN_FREE]: [],
  // Pro ($20/seat) is a HOSTED tier, not a feature tier: unlimited resources,
  // managed credits, email support. Its website bullets (scheduling, webhooks,
  // analytics, audit log) are all already community features, so Pro grants no
  // additional gated EE entitlements. (Hosted usage caps live outside the
  // entitlement token.)
  [PLAN_PRO]: [],
  // Business ($60/seat) is the governance tier from almyty.com/pricing:
  // SSO + role-based access control, approvals, PII filtering.
  [PLAN_BUSINESS]: [
    EE_ENTITLEMENTS.SSO,
    EE_ENTITLEMENTS.ADVANCED_RBAC,
    EE_ENTITLEMENTS.APPROVAL_POLICY,
    EE_ENTITLEMENTS.COMPLIANCE_PACK,
    EE_ENTITLEMENTS.AUDIT_EXPORT,
  ],
  // Enterprise (custom / contact sales) = Business + SCIM (part of SSO),
  // customer-managed keys/private cloud, and cost attribution.
  [PLAN_ENTERPRISE]: [
    EE_ENTITLEMENTS.SSO,
    EE_ENTITLEMENTS.ADVANCED_RBAC,
    EE_ENTITLEMENTS.APPROVAL_POLICY,
    EE_ENTITLEMENTS.COMPLIANCE_PACK,
    EE_ENTITLEMENTS.AUDIT_EXPORT,
    EE_ENTITLEMENTS.BYO_KMS,
    EE_ENTITLEMENTS.CHARGEBACK,
  ],
};

/** Stripe subscription statuses that keep a plan's entitlements live. */
export const ACTIVE_SUBSCRIPTION_STATUSES = ['active', 'trialing'];

/** Statuses that trigger the dunning grace window (soft-fail, keep access). */
export const DUNNING_SUBSCRIPTION_STATUSES = ['past_due', 'unpaid'];

/** Terminal statuses → downgrade to free + revoke token. */
export const TERMINAL_SUBSCRIPTION_STATUSES = ['canceled', 'incomplete_expired'];
