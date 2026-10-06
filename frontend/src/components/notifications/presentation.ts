// Per-event-type presentation: icon, accent color, human label and a
// one-line description. Shared by the bell dropdown, the /notifications
// page, and the Settings -> Notifications preference matrix so every
// surface renders an event type the same way.
import {
  AlertTriangle,
  Archive,
  Bell,
  CircleSlash,
  Sparkles,
  Coins,
  Gift,
  Globe,
  KeyRound,
  Lock,
  PauseCircle,
  Radio,
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
  'agent.report': {
    icon: Radio,
    accentClass: 'text-violet-500',
    label: 'Agent report',
    description: 'An always-on agent finished a wake and reported what it did.',
  },
  'agent.paused': {
    icon: PauseCircle,
    accentClass: 'text-amber-500',
    label: 'Agent paused',
    description: 'An always-on agent stopped itself, and says why.',
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
  'connections.expiring': {
    icon: KeyRound,
    accentClass: 'text-amber-500',
    label: 'Credential expiring',
    description: 'A credential expires soon. Replace its key before it stops working.',
  },
  'connections.expired': {
    icon: KeyRound,
    accentClass: 'text-red-500',
    label: 'Credential expired',
    description: 'A credential has expired and who may use it was paused.',
  },
  'connections.inactive': {
    icon: KeyRound,
    accentClass: 'text-red-500',
    label: 'Connection inactive',
    description: 'A provider refused a connection’s key, so it was turned off. Replace the key and check again to turn it back on.',
  },
  'connections.rotation_due': {
    icon: KeyRound,
    accentClass: 'text-cyan-500',
    label: 'Rotation due',
    description: 'A credential is older than your rotation rule allows.',
  },
  'domains.unverified': {
    icon: Globe,
    accentClass: 'text-red-500',
    label: 'Custom domain stopped',
    description: 'A hosted chat custom domain lost its DNS proof and is no longer served.',
  },
  'models.new': {
    icon: Sparkles,
    accentClass: 'text-cyan-500',
    label: 'New models',
    description: 'A provider connection started offering new models. Emailed in the daily summary.',
  },
  'models.unavailable': {
    icon: CircleSlash,
    accentClass: 'text-amber-500',
    label: 'Model no longer available',
    description: 'A model stopped working on a provider connection. Emailed at once when an agent uses it, otherwise in the daily summary.',
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
