/**
 * Licensing constants for the OSS/EE entitlement boundary.
 *
 * The community (OSS) build ships with a built-in Ed25519 PUBLIC key and no
 * license token, so it resolves to the community entitlement set. A commercial
 * (EE) deployment supplies a signed token via `ALMYTY_LICENSE_KEY` that the
 * public key verifies offline. The token is what unlocks EE features — never
 * the mutable `organization.plan` string.
 */

/** Env var holding the base64/PEM Ed25519 public key used to verify tokens. */
export const LICENSE_PUBLIC_KEY_ENV = 'ALMYTY_LICENSE_PUBLIC_KEY';

/** Env vars (either accepted) holding the signed license token. */
export const LICENSE_TOKEN_ENV = 'ALMYTY_LICENSE_KEY';
export const LICENSE_TOKEN_ENV_ALT = 'ALMYTY_LICENSE_TOKEN';

/** Sentinel returned by `LicenseService.limit()` when a key is uncapped. */
export const UNLIMITED = -1;

/** License editions. */
export const EDITION_COMMUNITY = 'community';
export const EDITION_ENTERPRISE = 'enterprise';

/**
 * Enterprise-only feature keys. These are DENIED in the community build and
 * only granted by a valid, signed license token. Keep this list in sync with
 * the EE roadmap (docs/plans/monetization-byok-open-core.md, WS3.3).
 */
export const EE_ENTITLEMENTS = {
  SSO: 'sso',
  ADVANCED_RBAC: 'advanced_rbac',
  AUDIT_EXPORT: 'audit_export',
  COMPLIANCE_PACK: 'compliance_pack',
  CHARGEBACK: 'chargeback',
  BYO_KMS: 'byo_kms',
  APPROVAL_POLICY: 'approval_policy',
  /** Placeholder feature demonstrating the ee/ boundary + guard wiring. */
  EXAMPLE_EE_FEATURE: 'example_ee_feature',
} as const;

/**
 * Core (community) entitlements. Every OSS self-hoster gets these for free and
 * unconditionally — they are the product surface and adoption funnel, never
 * gated. See the plan's guiding principle: "never gate a core primitive."
 */
export const COMMUNITY_ENTITLEMENTS: string[] = [
  'agents',
  'tools',
  'gateways',
  'mcp',
  'a2a',
  'utcp',
  'skills',
  'byok',
  'memory',
  'runner',
  'rbac_basic',
  'audit_basic',
  'spend_governance',
];

/** Community limits. Empty = uncapped; `LicenseService.limit()` returns UNLIMITED. */
export const COMMUNITY_LIMITS: Record<string, number> = {};

/**
 * Built-in default Ed25519 public key (SPKI PEM). Matches the dev keypair in
 * `backend/scripts/license/`. A real EE deployment overrides it via
 * `ALMYTY_LICENSE_PUBLIC_KEY`; the matching private key is held offline by the
 * vendor and is NOT in this repo (the dev private key is for local testing only).
 */
export const DEFAULT_LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAGMgHVuZL84VHwKDME7ynNIap1EfQH3RAqIEGFbJTFJ8=
-----END PUBLIC KEY-----`;
