/** Cookie carrying the referral attribution code between /r/<code> and registration. */
export const REFERRAL_COOKIE = 'almyty_ref';

/** How long an attribution cookie is honoured. */
export const REFERRAL_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Best-effort client IP for abuse heuristics. The app runs behind nginx /
 * an ingress in every deployed environment and Express `trust proxy` is not
 * enabled, so `req.ip` would be the proxy address for every request — which
 * would flag ALL referrals as same-IP. Prefer the first X-Forwarded-For hop
 * (set by our own nginx) and fall back to req.ip for direct local traffic.
 * This is a guardrail input, not an auth decision.
 */
export function clientIpOf(req: {
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
}): string | undefined {
  const xff = req.headers?.['x-forwarded-for'];
  const first = Array.isArray(xff) ? xff[0] : xff;
  if (first) {
    const ip = first.split(',')[0]?.trim();
    if (ip) return ip;
  }
  return req.ip || undefined;
}

/** Reward sizing — overridable via env so product can tune without a deploy. */
export function tier1RewardDays(): number {
  return Number(process.env.REFERRAL_TIER1_DAYS) || 14;
}

export function tier2RewardDays(): number {
  return Number(process.env.REFERRAL_TIER2_DAYS) || 30;
}

export function refereeRewardDays(): number {
  return Number(process.env.REFERRAL_REFEREE_DAYS) || 30;
}

/** Max reward days a referrer can bank per rolling year. */
export function yearlyCapDays(): number {
  return Number(process.env.REFERRAL_YEARLY_CAP_DAYS) || 365;
}

/**
 * Small static blocklist of disposable-email domains. Deliberately short —
 * this is a guardrail that flags for manual review, not a spam filter.
 */
export const DISPOSABLE_EMAIL_DOMAINS = new Set([
  'mailinator.com',
  'guerrillamail.com',
  'guerrillamail.net',
  'sharklasers.com',
  '10minutemail.com',
  '10minutemail.net',
  'tempmail.com',
  'temp-mail.org',
  'tempmail.dev',
  'yopmail.com',
  'trashmail.com',
  'getnada.com',
  'dispostable.com',
  'maildrop.cc',
  'mintemail.com',
  'throwawaymail.com',
  'mailnesia.com',
  'fakeinbox.com',
  'spamgourmet.com',
  'mytemp.email',
]);

export function isDisposableEmail(email: string): boolean {
  const domain = (email.split('@')[1] || '').trim().toLowerCase();
  return DISPOSABLE_EMAIL_DOMAINS.has(domain);
}
