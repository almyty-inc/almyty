import { HarnessAuthMode } from '../../entities/harness.entity';
import { DistributionTarget } from '../../entities/harness-distribution.entity';

/**
 * The rules that decide whether a harness may ship.
 *
 * Kept as pure functions with no repository access so the same checks
 * run in the builder before an operator saves, in the API before it
 * accepts, and in the CLI before it builds an artifact. A rule that
 * only exists in one of those three is a rule someone routes around.
 */

const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** Names a distribution would collide with, or that we route ourselves. */
export const RESERVED_HARNESS_SLUGS = Object.freeze([
  'www', 'api', 'app', 'admin', 'docs', 'status', 'staging', 'dev',
  'chat', 'mail', 'assets', 'static', 'cdn', 'download', 'install',
]);

export function harnessSlugError(slug: string): string | null {
  const value = (slug || '').trim().toLowerCase();
  if (!value) return 'Pick a name for the product.';
  if (value.length < 3) return 'Must be at least 3 characters.';
  if (value.length > 63) return 'Must be 63 characters or fewer.';
  if (!SLUG_PATTERN.test(value)) {
    return 'Use lowercase letters, numbers and hyphens. It cannot start or end with a hyphen.';
  }
  if (RESERVED_HARNESS_SLUGS.includes(value)) return 'That name is reserved.';
  return null;
}

/**
 * Reason codes for refusing to publish or build. Each is paired with a
 * sentence an operator can act on, following the same contract the run
 * limits and the hosted chat rules use.
 */
export const HARNESS_REFUSALS = Object.freeze({
  SLUG_INVALID: 'The product name is missing or not usable as an address.',
  NO_AGENTS:
    'A product needs at least one agent. Add one before publishing, or there is nothing for a user to talk to.',
  PUBLIC_NEEDS_COST_CAP:
    'Anyone with the link or the binary can use this, so it needs a cost cap first. Without one, a stranger can spend against your model keys.',
  PUBLIC_NEEDS_RATE_LIMIT:
    'A product open to anyone needs a per-user and a per-IP rate limit, so one user cannot exhaust it for everyone else.',
  SSO_NOT_ENTITLED: 'Signing in with your own directory requires a commercial licence.',
  WHITE_LABEL_NOT_ENTITLED: 'Removing the almyty mark requires a commercial licence.',
  DISCLOSURE_REMOVAL_NOT_ENTITLED:
    'Removing the AI disclosure requires the white-label entitlement (EU AI Act Art. 50).',
  LOCAL_ACCESS_NEEDS_APPROVAL_GATE:
    'A product that can run local commands must ask the user before it does. Add an approval requirement, or turn shell access off.',
  LOCAL_ACCESS_ON_PUBLIC:
    'A product anyone can download must not have local filesystem or shell access. Restrict who can use it, or remove the access.',
  BUNDLE_ID_INVALID:
    'Desktop and binary builds need a reverse-domain identifier such as com.acme.assistant.',
});

export type HarnessRefusalCode = keyof typeof HARNESS_REFUSALS;

export interface HarnessCheck {
  ok: boolean;
  refusals: Array<{ code: HarnessRefusalCode; message: string }>;
}

export interface HarnessShape {
  slug?: string;
  agentIds?: string[];
  authMode?: HarnessAuthMode | string;
  branding?: { aiDisclosure?: string | null; whiteLabel?: boolean } | null;
  capabilities?: {
    filesystemRead?: string[];
    filesystemWrite?: string[];
    shell?: boolean;
    network?: boolean;
    requireApprovalFor?: string[];
  } | null;
}

export interface HarnessContext {
  costCapCents?: number | null;
  perUserRateLimit?: number | null;
  perIpRateLimit?: number | null;
  hasWhiteLabel?: boolean;
  hasEnterpriseAuth?: boolean;
}

/** True when anyone holding the link or the artifact can use it. */
export function isOpenToAnyone(authMode: HarnessAuthMode | string | undefined): boolean {
  return (authMode ?? HarnessAuthMode.PUBLIC_LINK) === HarnessAuthMode.PUBLIC_LINK;
}

/** True when the harness grants any access to the machine it runs on. */
export function grantsLocalAccess(capabilities: HarnessShape['capabilities']): boolean {
  if (!capabilities) return false;
  return (
    capabilities.shell === true ||
    (capabilities.filesystemRead?.length ?? 0) > 0 ||
    (capabilities.filesystemWrite?.length ?? 0) > 0
  );
}

/**
 * Whether a harness may be published or built.
 *
 * The two rules worth stating out loud, because they are the ones that
 * turn a demo into an incident:
 *
 * An open product with no cost cap hands strangers the customer's model
 * spend. A downloadable product with local access hands strangers a
 * shell on whoever installs it: the artifact runs on someone else's
 * machine, so "anyone may use it" and "it may run commands" must never
 * be true at the same time.
 */
export function checkHarness(
  harness: HarnessShape,
  context: HarnessContext = {},
): HarnessCheck {
  const refusals: Array<{ code: HarnessRefusalCode; message: string }> = [];
  const refuse = (code: HarnessRefusalCode) =>
    refusals.push({ code, message: HARNESS_REFUSALS[code] });

  if (harnessSlugError(harness.slug ?? '')) refuse('SLUG_INVALID');
  if (!harness.agentIds?.length) refuse('NO_AGENTS');

  const open = isOpenToAnyone(harness.authMode);
  if (open) {
    if (!context.costCapCents || context.costCapCents <= 0) refuse('PUBLIC_NEEDS_COST_CAP');
    if ((context.perUserRateLimit ?? 0) <= 0 || (context.perIpRateLimit ?? 0) <= 0) {
      refuse('PUBLIC_NEEDS_RATE_LIMIT');
    }
  }

  if (harness.authMode === HarnessAuthMode.SSO && !context.hasEnterpriseAuth) {
    refuse('SSO_NOT_ENTITLED');
  }

  if (harness.branding?.whiteLabel && !context.hasWhiteLabel) refuse('WHITE_LABEL_NOT_ENTITLED');

  // Null means the default line. An empty string is a removal.
  const disclosure = harness.branding?.aiDisclosure;
  if (disclosure !== null && disclosure !== undefined && disclosure.trim() === '') {
    if (!context.hasWhiteLabel) refuse('DISCLOSURE_REMOVAL_NOT_ENTITLED');
  }

  if (grantsLocalAccess(harness.capabilities)) {
    if (open) refuse('LOCAL_ACCESS_ON_PUBLIC');
    if (harness.capabilities?.shell && !(harness.capabilities.requireApprovalFor?.length)) {
      refuse('LOCAL_ACCESS_NEEDS_APPROVAL_GATE');
    }
  }

  return { ok: refusals.length === 0, refusals };
}

const BUNDLE_ID_PATTERN = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;

/** Targets that produce a file someone installs, and so need an identity. */
const PACKAGED_TARGETS: readonly DistributionTarget[] = Object.freeze([
  DistributionTarget.DESKTOP,
  DistributionTarget.BINARY,
]);

/**
 * Whether a distribution can be built, on top of the harness rules.
 *
 * A packaged target needs a bundle identifier because every desktop
 * packager and code-signing toolchain requires one, and a placeholder
 * would collide with every other product built from the same default.
 */
export function checkDistribution(
  target: DistributionTarget | string,
  harness: HarnessShape,
  configuration: { bundleId?: string } | null | undefined,
  context: HarnessContext = {},
): HarnessCheck {
  const base = checkHarness(harness, context);
  const refusals = [...base.refusals];

  if (PACKAGED_TARGETS.includes(target as DistributionTarget)) {
    const bundleId = (configuration?.bundleId ?? '').trim();
    if (!BUNDLE_ID_PATTERN.test(bundleId)) {
      refusals.push({
        code: 'BUNDLE_ID_INVALID',
        message: HARNESS_REFUSALS.BUNDLE_ID_INVALID,
      });
    }
  }

  return { ok: refusals.length === 0, refusals };
}
