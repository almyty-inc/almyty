/**
 * The closed set of notification event types. These strings are part of
 * the frontend API contract (preferences matrix keys + notification
 * `type` field) — do not rename without coordinating a frontend change.
 */
export const NOTIFICATION_EVENT_TYPES = [
  'approval.pending',
  'approval.decided',
  'run.failed',
  'budget.alert',
  'invite.received',
  'referral.qualified',
  'referral.rewarded',
  'security.sso_install',
  'security.scim_deprovision',
  'retention.sweep',
  'account.welcome',
  'account.verify_email',
  'account.password_reset',
] as const;

export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

export interface ChannelPrefs {
  inApp: boolean;
  email: boolean;
}

/**
 * Per-type channel defaults, applied when a user has no explicit
 * NotificationPreference row for the type.
 *
 * Rationale:
 *  - in-app defaults ON everywhere (cheap, non-intrusive).
 *  - `run.failed` email defaults OFF — scheduled agents can fail on
 *    every tick and a per-failure email is a storm generator.
 *  - security.* and account.* email ON — these are the notifications
 *    users must not miss.
 */
export const NOTIFICATION_DEFAULTS: Record<NotificationEventType, ChannelPrefs> = {
  'approval.pending': { inApp: true, email: true },
  'approval.decided': { inApp: true, email: true },
  'run.failed': { inApp: true, email: false },
  'budget.alert': { inApp: true, email: true },
  'invite.received': { inApp: true, email: true },
  'referral.qualified': { inApp: true, email: true },
  'referral.rewarded': { inApp: true, email: true },
  'security.sso_install': { inApp: true, email: true },
  'security.scim_deprovision': { inApp: true, email: true },
  'retention.sweep': { inApp: true, email: true },
  'account.welcome': { inApp: true, email: true },
  'account.verify_email': { inApp: true, email: true },
  'account.password_reset': { inApp: true, email: true },
};

/**
 * Transactional account-security emails that must reach the user even
 * when their email preference for the type is off (a user who disabled
 * `account.password_reset` emails could never reset their password) and
 * that bypass the per-type rate cap (a user may legitimately re-request
 * a reset/verification link within the cap window; both are
 * user-initiated so they cannot storm).
 */
export const MANDATORY_EMAIL_TYPES: ReadonlySet<string> = new Set([
  'account.verify_email',
  'account.password_reset',
]);

/** Digest guard: at most one email per user per type in this window. */
export const EMAIL_RATE_CAP_MS = 10 * 60 * 1000;

export function isNotificationEventType(value: string): value is NotificationEventType {
  return (NOTIFICATION_EVENT_TYPES as readonly string[]).includes(value);
}
