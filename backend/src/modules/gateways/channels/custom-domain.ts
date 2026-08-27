import { createHash, randomBytes } from 'crypto';

/**
 * Tier 2 of the hosted chat app: a tenant serves their chat on a domain
 * they own, chat.acme.com, rather than a subdomain of ours.
 *
 * The hard part is not routing, it is proving the tenant controls the
 * domain before we issue a certificate for it or serve their agent
 * under it. Without that check, anyone could claim any hostname and we
 * would obligingly request a certificate for it.
 *
 * Verification is a DNS TXT record, not a file on a web server: the
 * domain does not point at us yet at the moment we need to verify it,
 * which is the whole reason the tenant is doing this.
 */

/** Where the verification record is published. */
export const VERIFICATION_RECORD_PREFIX = '_almyty-verify';

/** The value prefix, so the record is self-describing in a zone file. */
export const VERIFICATION_VALUE_PREFIX = 'almyty-domain-verification=';

export type CustomDomainStatus =
  | 'pending_verification'
  | 'verifying'
  | 'verified'
  | 'failed'
  | 'active';

export interface CustomDomainConfig {
  hostname: string;
  status: CustomDomainStatus;
  /** Random per-domain token; the tenant publishes this in DNS. */
  verificationToken: string;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
}

/**
 * Hostname rules for something that will become a TLS SAN and an ingress
 * rule. Deliberately stricter than what DNS technically permits: no
 * wildcards, no trailing dot, no bare single label, and nothing that
 * could be read as a URL rather than a hostname.
 */
export function customDomainError(hostname: string): string | null {
  const value = (hostname || '').trim().toLowerCase();
  if (!value) return 'Enter the domain you want to use.';
  if (value.length > 253) return 'That domain is too long.';
  if (value.includes('/') || value.includes(':')) {
    return 'Enter a hostname only, without https:// or a path.';
  }
  if (value.startsWith('*')) return 'Wildcard domains are not supported here.';
  if (value.endsWith('.')) return 'Remove the trailing dot.';

  const labels = value.split('.');
  if (labels.length < 2) return 'Use a full domain, for example chat.acme.com.';
  for (const label of labels) {
    if (!label || label.length > 63) return 'Each part of the domain must be 1 to 63 characters.';
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) {
      return 'Use letters, numbers and hyphens. No part may start or end with a hyphen.';
    }
  }
  return null;
}

/**
 * Domains we will never serve for a tenant, because doing so would let
 * them mint a certificate for, or impersonate, something of ours.
 */
export function isReservedDomain(hostname: string, baseDomain: string): boolean {
  const value = (hostname || '').trim().toLowerCase();
  const base = (baseDomain || '').trim().toLowerCase();
  if (!value) return false;
  // The base domain is ours, and so is everything under it: those are
  // Tier 1 subdomains, not customer domains.
  if (value === base || value.endsWith(`.${base}`)) return true;
  // Registrable-domain suffix of the base, so almyty.com and its
  // subdomains cannot be claimed via the Tier 2 path either.
  const baseParts = base.split('.');
  const org = baseParts.length >= 2 ? baseParts.slice(-2).join('.') : base;
  const orgRoot = org.split('.')[0];
  return value === orgRoot || value.endsWith(`.${orgRoot}.`) || value.split('.').slice(-2)[0] === orgRoot;
}

export function newVerificationToken(): string {
  return randomBytes(24).toString('hex');
}

/** The DNS record a tenant has to publish, ready to copy. */
export function verificationRecord(config: Pick<CustomDomainConfig, 'hostname' | 'verificationToken'>): {
  type: 'TXT';
  name: string;
  value: string;
} {
  return {
    type: 'TXT',
    name: `${VERIFICATION_RECORD_PREFIX}.${config.hostname}`,
    value: `${VERIFICATION_VALUE_PREFIX}${config.verificationToken}`,
  };
}

/**
 * Whether the TXT records found at the verification name prove control.
 *
 * Accepts a list because a zone routinely holds several TXT records at
 * one name, and resolvers may split a long value into chunks. Matching
 * is exact against the expected value rather than a substring test: a
 * substring match would accept a record that merely mentions our token
 * inside something else.
 */
export function isVerified(
  records: string[] | null | undefined,
  config: Pick<CustomDomainConfig, 'verificationToken'>,
): boolean {
  if (!records?.length) return false;
  const expected = `${VERIFICATION_VALUE_PREFIX}${config.verificationToken}`;
  return records.some((record) => (record ?? '').trim().replace(/^"|"$/g, '') === expected);
}

/**
 * A stable, DNS-safe name for the Kubernetes objects backing a custom
 * domain, derived from the hostname. Hostnames can contain characters
 * and lengths a resource name cannot, so this hashes rather than
 * sanitises: two different hostnames must never collide onto one
 * certificate.
 */
export function resourceNameFor(hostname: string): string {
  const digest = createHash('sha256').update(hostname.trim().toLowerCase()).digest('hex').slice(0, 10);
  const readable = hostname
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `chat-${readable}-${digest}`;
}

export function newCustomDomain(hostname: string): CustomDomainConfig {
  return {
    hostname: hostname.trim().toLowerCase(),
    status: 'pending_verification',
    verificationToken: newVerificationToken(),
    verifiedAt: null,
    lastCheckedAt: null,
    lastError: null,
  };
}

/** Reason codes for refusing a custom domain, paired with a sentence. */
export const CUSTOM_DOMAIN_REFUSALS = Object.freeze({
  DOMAIN_INVALID: 'That is not a hostname we can serve.',
  DOMAIN_RESERVED: 'That domain belongs to almyty and cannot be claimed.',
  DOMAIN_NOT_VERIFIED:
    'Publish the TXT record shown above, then check again. DNS changes can take a few minutes to propagate.',
  DOMAIN_ALREADY_CLAIMED: 'Another surface is already serving that domain.',
});

export type CustomDomainRefusalCode = keyof typeof CUSTOM_DOMAIN_REFUSALS;
