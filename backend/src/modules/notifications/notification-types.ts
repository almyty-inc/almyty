/**
 * The closed set of notification event types. These strings are part of
 * the frontend API contract (preferences matrix keys + notification
 * `type` field) — do not rename without coordinating a frontend change.
 */
export const NOTIFICATION_EVENT_TYPES = [
  'approval.pending',
  'approval.decided',
  'run.failed',
  'agent.report',
  'agent.paused',
  'budget.alert',
  'invite.received',
  'referral.qualified',
  'referral.rewarded',
  'security.sso_install',
  'security.scim_deprovision',
  'retention.sweep',
  'connections.expiring',
  'connections.expired',
  'connections.rotation_due',
  'connections.inactive',
  'domains.unverified',
  'models.new',
  'models.unavailable',
  'account.welcome',
  'account.verify_email',
  'account.password_reset',
] as const;

export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

export interface ChannelPrefs {
  inApp: boolean;
  email: boolean;
  /** Shown in the app whatever the person set; only the email can be turned off. */
  inAppLocked?: boolean;
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
  // An always-on agent's report after a wake: in the app; by email only
  // for someone who asks for it (a busy agent reports often).
  'agent.report': { inApp: true, email: false },
  // An always-on agent paused itself (it looped, its owner lost access):
  // nothing runs until someone looks, so it is emailed too.
  'agent.paused': { inApp: true, email: true },
  'budget.alert': { inApp: true, email: true },
  'connections.expiring': { inApp: true, email: true },
  'connections.expired': { inApp: true, email: true },
  'connections.rotation_due': { inApp: true, email: false },
  // A provider refused a connection's key and it was turned off: in the
  // app for its owner and the admins, and by email unless they turn it off.
  'connections.inactive': { inApp: true, email: true },
  'domains.unverified': { inApp: true, email: true },
  // A model appearing or going away on a provider connection: always in
  // the app; the email (at once for a model an agent uses, else in the
  // daily digest) is each person's to turn off.
  'models.new': { inApp: true, email: true, inAppLocked: true },
  'models.unavailable': { inApp: true, email: true, inAppLocked: true },
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
