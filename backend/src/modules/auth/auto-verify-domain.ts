/**
 * AUTO_VERIFY_EMAIL_DOMAIN: for test environments only, never production.
 *
 * Sign-in needs a confirmed email address, and an automated journey on a
 * test stack has no inbox to open the link from. With this variable set
 * to one domain (e.g. `test.almyty.com`), an account registered on exactly
 * that domain is confirmed at once and no verification email is sent.
 *
 * Exact match on the part after the last `@`: a subdomain
 * (`a.test.almyty.com`), a look-alike (`evil-test.almyty.com`) or a suffix
 * trick (`test.almyty.com.evil.com`) does not match. Unset (the default)
 * changes nothing.
 */
export const AUTO_VERIFY_EMAIL_DOMAIN_ENV = 'AUTO_VERIFY_EMAIL_DOMAIN';

/** The configured domain, lower-cased, or null when unset or blank. */
export function autoVerifyEmailDomain(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env[AUTO_VERIFY_EMAIL_DOMAIN_ENV] ?? '').trim().toLowerCase().replace(/^@/, '');
  return raw ? raw : null;
}

/** True when `email` is an address exactly on `domain`. */
export function isOnAutoVerifyDomain(email: string, domain: string | null): boolean {
  if (!domain || typeof email !== 'string') return false;
  const at = email.lastIndexOf('@');
  if (at <= 0) return false;
  return email.slice(at + 1).trim().toLowerCase() === domain;
}
