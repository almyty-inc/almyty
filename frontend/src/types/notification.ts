// Notification types — mirrors the frozen backend contract:
//   GET  /notifications?unreadOnly=&page=&limit=
//   POST /notifications/:id/read, POST /notifications/read-all
//   GET/PUT /notifications/preferences

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
] as const

export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number]

export interface AppNotification {
  id: string
  // Union for the known types, but the server may ship new ones —
  // presentation always falls back gracefully on unknown strings.
  type: NotificationEventType | (string & {})
  title: string
  body?: string | null
  link?: string | null
  createdAt: string
  readAt: string | null
}

export interface NotificationListResult {
  notifications: AppNotification[]
  total: number
  unreadCount: number
}

export interface NotificationChannelPreference {
  inApp: boolean
  email: boolean
  /**
   * The backend may mark a preference as locked (e.g. security
   * notices are always emailed). Render-only — never hardcode
   * which rows are locked; trust the fetched defaults.
   */
  locked?: boolean
  emailLocked?: boolean
}

export type NotificationPreferenceMatrix = Record<string, NotificationChannelPreference>

export interface NotificationPreferencesResult {
  matrix: NotificationPreferenceMatrix
  defaults: NotificationPreferenceMatrix
}
