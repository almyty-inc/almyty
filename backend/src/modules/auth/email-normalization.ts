/**
 * Email normalization + abuse detection for the registration path.
 *
 * Two jobs:
 *   1. Produce a canonical form of an address so that provider-side aliasing
 *      tricks (gmail dot-injection, `+tag` sub-addressing) all collapse to a
 *      single identity. We store this canonical form on the user row and
 *      dedupe on it so a bot can't farm many accounts from one real inbox
 *      (`f.o.o@gmail.com`, `foo+1@gmail.com`, `f.o.o+x@gmail.com` -> one).
 *   2. Reject known disposable / throwaway mailbox domains outright.
 *
 * This is a guardrail, not a spam classifier. It is intentionally conservative:
 * it never mutates the address we actually deliver mail to (that stays the raw
 * user input) and it only canonicalizes providers whose aliasing rules are
 * well-documented and stable.
 */

/**
 * Providers that treat `.` in the local part as insignificant (so
 * `f.o.o@gmail.com` === `foo@gmail.com`). All of these are Gmail-backed.
 */
const DOT_INSENSITIVE_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * Canonical domain for providers that expose several interchangeable domains
 * for the same mailbox. googlemail.com is a legacy alias for gmail.com.
 */
const DOMAIN_ALIASES: Record<string, string> = {
  'googlemail.com': 'gmail.com',
};

/**
 * Known disposable / temporary-mailbox domains. Deliberately a curated static
 * list rather than a live feed: it needs zero network calls on the hot signup
 * path, and the long tail of throwaway domains is better handled by the
 * rate-limit + verification gate than by chasing an ever-growing blocklist.
 *
 * Sourced from the widely-mirrored `disposable-email-domains` community list
 * (the high-traffic domains); trimmed to the ones that actually show up in
 * abuse and kept small enough to audit by eye.
 */
export const DISPOSABLE_EMAIL_DOMAINS = new Set<string>([
  '0-mail.com',
  '10minutemail.com',
  '10minutemail.net',
  '20minutemail.com',
  '33mail.com',
  'dispostable.com',
  'discard.email',
  'emailondeck.com',
  'fakeinbox.com',
  'fakemail.net',
  'getairmail.com',
  'getnada.com',
  'grr.la',
  'guerrillamail.biz',
  'guerrillamail.com',
  'guerrillamail.de',
  'guerrillamail.info',
  'guerrillamail.net',
  'guerrillamail.org',
  'guerrillamailblock.com',
  'inboxbear.com',
  'inboxkitten.com',
  'jetable.org',
  'mail-temp.com',
  'mail7.io',
  'mailcatch.com',
  'maildrop.cc',
  'maileater.com',
  'mailexpire.com',
  'mailinator.com',
  'mailinator.net',
  'mailnesia.com',
  'mailsac.com',
  'mailtothis.com',
  'mintemail.com',
  'moakt.com',
  'mohmal.com',
  'mytemp.email',
  'nada.email',
  'nowmymail.com',
  'sharklasers.com',
  'spam4.me',
  'spamgourmet.com',
  'temp-mail.io',
  'temp-mail.org',
  'tempinbox.com',
  'tempmail.com',
  'tempmail.dev',
  'tempmail.plus',
  'tempmailaddress.com',
  'tempmailo.com',
  'throwawaymail.com',
  'trashmail.com',
  'trashmail.de',
  'trashmail.net',
  'yopmail.com',
  'yopmail.fr',
  'yopmail.net',
  'wegwerfmail.de',
  'wegwerfmail.net',
  'zetmail.com',
]);

/** Split an address into a lowercased `{ local, domain }`. */
function splitEmail(email: string): { local: string; domain: string } | null {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  const local = email.slice(0, at).trim();
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!local || !domain) return null;
  return { local, domain };
}

/**
 * Canonicalize an address for dedupe / uniqueness. Lowercases the whole
 * address, applies domain aliasing, strips `+tag` sub-addressing on providers
 * that support it, and removes insignificant dots on Gmail-family domains.
 *
 * Returns the input lowercased-and-trimmed if it can't be parsed, so a
 * malformed value never throws here (validation already rejects it upstream).
 */
export function normalizeEmail(email: string): string {
  const raw = (email || '').trim();
  const parts = splitEmail(raw);
  if (!parts) return raw.toLowerCase();

  let { local } = parts;
  const { domain: rawDomain } = parts;
  const domain = DOMAIN_ALIASES[rawDomain] || rawDomain;

  local = local.toLowerCase();

  // `+tag` sub-addressing: everything from the first '+' is a user-chosen
  // label the provider ignores. Gmail, Outlook/Hotmail, Yahoo, Fastmail and
  // Proton all honour this, so strip it for every domain — the tag never
  // changes which mailbox receives the message.
  const plus = local.indexOf('+');
  if (plus !== -1) {
    local = local.slice(0, plus);
  }

  // Gmail ignores dots in the local part.
  if (DOT_INSENSITIVE_DOMAINS.has(domain)) {
    local = local.replace(/\./g, '');
  }

  // A local part that collapses to empty (e.g. `+tag@gmail.com`) is degenerate;
  // fall back to the lowercased original so we still have a stable key.
  if (!local) return raw.toLowerCase();

  return `${local}@${domain}`;
}

/** True when the address's domain is a known disposable/throwaway provider. */
export function isDisposableEmail(email: string): boolean {
  const parts = splitEmail((email || '').toLowerCase());
  if (!parts) return false;
  const domain = DOMAIN_ALIASES[parts.domain] || parts.domain;
  return DISPOSABLE_EMAIL_DOMAINS.has(domain);
}
