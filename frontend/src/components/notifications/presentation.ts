// Per-event-type presentation: icon, accent color, human label and a
// one-line description. Shared by the bell dropdown, the /notifications
// page, and the Settings -> Notifications preference matrix so every
// surface renders an event type the same way.
import {
  AlertTriangle,
  Archive,
  Bell,
  Coins,
  Gift,
  KeyRound,
  Lock,
  Shield,
  ShieldCheck,
  User,
  UserPlus,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export interface NotificationPresentation {
  icon: LucideIcon
  /** Tailwind text color class applied to the icon. */
  accentClass: string
  label: string
  description: string
}

const PRESENTATION: Record<string, NotificationPresentation> = {
  'approval.pending': {
    icon: Shield,
    accentClass: 'text-violet-500',
    label: 'Approval requested',
    description: 'An agent run is waiting for your approval.',
  },
  'approval.decided': {
    icon: ShieldCheck,
    accentClass: 'text-violet-500',
    label: 'Approval decided',
    description: 'A pending approval you follow was approved or denied.',
  },
  'run.failed': {
    icon: AlertTriangle,
    accentClass: 'text-red-500',
    label: 'Run failed',
    description: 'An agent run ended with an error.',
  },
  'budget.alert': {
    icon: Coins,
    accentClass: 'text-amber-500',
    label: 'Budget alert',
    description: 'Spending crossed a configured budget threshold.',
  },
  'invite.received': {
    icon: UserPlus,
    accentClass: 'text-cyan-500',
    label: 'Invitation received',
    description: 'You were invited to join an organization or team.',
  },
  'referral.qualified': {
    icon: Gift,
    accentClass: 'text-emerald-500',
    label: 'Referral qualified',
    description: 'Someone you referred became a qualified signup.',
  },
  'referral.rewarded': {
    icon: Gift,
    accentClass: 'text-emerald-500',
    label: 'Referral rewarded',
    description: 'A referral reward was credited to your account.',
  },
  'security.sso_install': {
    icon: Lock,
    accentClass: 'text-rose-500',
    label: 'SSO change',
    description: 'Single sign-on was installed or changed for your organization.',
  },
  'security.scim_deprovision': {
    icon: Lock,
    accentClass: 'text-rose-500',
    label: 'SCIM deprovisioning',
    description: 'A member was deprovisioned via your identity provider.',
  },
  'retention.sweep': {
    icon: Archive,
    accentClass: 'text-slate-400',
    label: 'Retention sweep',
    description: 'Old data was removed by your data retention policy.',
  },
  'account.welcome': {
    icon: User,
    accentClass: 'text-cyan-500',
    label: 'Welcome',
    description: 'Getting-started messages for your account.',
  },
  'account.verify_email': {
    icon: User,
    accentClass: 'text-cyan-500',
    label: 'Verify email',
    description: 'Email address verification requests.',
  },
  'account.password_reset': {
    icon: KeyRound,
    accentClass: 'text-cyan-500',
    label: 'Password reset',
    description: 'Password reset confirmations for your account.',
  },
}

/** "budget.alert" -> "Budget alert" for types we do not know yet. */
function humanizeType(type: string): string {
  const words = type.replace(/[._]/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function getNotificationPresentation(type: string): NotificationPresentation {
  return (
    PRESENTATION[type] ?? {
      icon: Bell,
      accentClass: 'text-muted-foreground',
      label: humanizeType(type || 'Notification'),
      description: '',
    }
  )
}
