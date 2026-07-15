import { useState } from 'react'
import { captureEvent } from '@/lib/analytics'
import { useQuery, useMutation } from '@tanstack/react-query'
import { CreditCard, ExternalLink, Check, AlertTriangle } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { billingApi } from '@/lib/api'
import { useNotifications } from '@/store/app'

interface BillingStatus {
  plan: string
  seats: number
  status: string | null
  hasSubscription: boolean
  dunning: boolean
  graceUntil: string | null
  planExpiresAt: string | null
  hasLicenseToken: boolean
  stripeConfigured: boolean
}

interface Invoice {
  id: string
  number: string | null
  amountDue: number
  currency: string
  status: string | null
  created: string
  hostedInvoiceUrl: string | null
  pdfUrl: string | null
}

type BillingInterval = 'month' | 'year'

// Per-seat list prices (USD). Annual gives two months free: annual is billed as
// 10x the monthly rate. Kept in sync with almyty.com/pricing and the Stripe
// prices behind STRIPE_PRICE_* / STRIPE_PRICE_*_ANNUAL.
const SELF_SERVE_PLANS = [
  {
    key: 'pro',
    label: 'Pro',
    blurb: 'Unlimited resources, managed credits, email support.',
    monthly: 20,
  },
  {
    key: 'business',
    label: 'Business',
    blurb: 'SSO, advanced RBAC, approvals, PII filtering, audit export.',
    monthly: 60,
  },
] as const

function formatUsd(amount: number) {
  return `$${amount.toLocaleString('en-US')}`
}

function formatMoney(cents: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase() }).format(
      (cents || 0) / 100,
    )
  } catch {
    return `${((cents || 0) / 100).toFixed(2)} ${currency.toUpperCase()}`
  }
}

export function BillingTab({ organizationId }: { organizationId?: string }) {
  const { error } = useNotifications()
  const [interval, setInterval] = useState<BillingInterval>('month')

  const { data: status, isLoading } = useQuery<BillingStatus>({
    queryKey: ['billing-status', organizationId],
    queryFn: () => billingApi.getStatus(organizationId!),
    enabled: !!organizationId,
  })

  const { data: invoices } = useQuery<Invoice[]>({
    queryKey: ['billing-invoices', organizationId],
    queryFn: () => billingApi.getInvoices(organizationId!),
    enabled: !!organizationId && !!status?.hasSubscription,
  })

  const checkoutMutation = useMutation({
    mutationFn: (plan: string) => {
      captureEvent('checkout_started', { plan, interval })
      return billingApi.createCheckout(organizationId!, { plan, interval })
    },
    onSuccess: (res: { url: string }) => {
      if (res?.url) window.location.assign(res.url)
    },
    onError: (err: any) =>
      error('Checkout failed', err.response?.data?.message || 'Could not start checkout. Please try again.'),
  })

  const portalMutation = useMutation({
    mutationFn: () => billingApi.createPortal(organizationId!),
    onSuccess: (res: { url: string }) => {
      if (res?.url) window.location.assign(res.url)
    },
    onError: (err: any) =>
      error('Could not open billing portal', err.response?.data?.message || 'Please try again.'),
  })

  if (!organizationId) {
    return (
      <Card>
        <CardContent className="text-center py-8">
          <div className="text-muted-foreground">No organization selected</div>
        </CardContent>
      </Card>
    )
  }

  const plan = status?.plan || 'free'
  const isPaid = plan !== 'free'
  const annual = interval === 'year'

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <CreditCard className="h-5 w-5" /> Subscription
            </CardTitle>
            <CardDescription>Manage your almyty plan, seats, and invoices</CardDescription>
          </div>
          {isPaid && status?.hasSubscription && (
            <Button
              variant="outline"
              onClick={() => portalMutation.mutate()}
              disabled={portalMutation.isPending}
            >
              {portalMutation.isPending ? 'Opening...' : 'Manage billing'}
              <ExternalLink className="ml-1.5 h-4 w-4" />
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-5">
          {isLoading ? (
            <div className="h-6 w-40 bg-muted animate-pulse rounded" />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm text-muted-foreground">Current plan</span>
                <Badge variant={isPaid ? 'default' : 'secondary'} className="capitalize">
                  {plan}
                </Badge>
                {isPaid && (
                  <span className="text-sm text-muted-foreground">
                    {status?.seats} seat{status?.seats === 1 ? '' : 's'}
                  </span>
                )}
                {status?.status && (
                  <Badge variant="outline" className="capitalize">
                    {status.status.replace('_', ' ')}
                  </Badge>
                )}
              </div>

              {status?.dunning && (
                <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                  <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-500" />
                  <div>
                    <p className="font-medium">Payment issue</p>
                    <p className="text-muted-foreground">
                      Your last payment failed. Update your payment method to avoid losing access
                      {status.graceUntil
                        ? ` after ${new Date(status.graceUntil).toLocaleDateString()}`
                        : ''}
                      .
                    </p>
                  </div>
                </div>
              )}

              {status?.planExpiresAt && isPaid && (
                <p className="text-sm text-muted-foreground">
                  Renews / expires on {new Date(status.planExpiresAt).toLocaleDateString()}
                </p>
              )}

              {!status?.stripeConfigured && (
                <p className="text-sm text-muted-foreground italic">
                  Hosted billing is not configured for this deployment.
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {status?.stripeConfigured && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              {annual ? 'Billed annually · 2 months free' : 'Billed monthly'}
            </p>
            <div
              role="group"
              aria-label="Billing interval"
              className="inline-flex items-center rounded-lg border bg-muted p-0.5 text-sm"
            >
              <button
                type="button"
                aria-pressed={!annual}
                onClick={() => setInterval('month')}
                className={cn(
                  'rounded-md px-3 py-1.5 font-medium transition-colors',
                  !annual ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground',
                )}
              >
                Monthly
              </button>
              <button
                type="button"
                aria-pressed={annual}
                onClick={() => setInterval('year')}
                className={cn(
                  'rounded-md px-3 py-1.5 font-medium transition-colors',
                  annual ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground',
                )}
              >
                Annual
                <span className="ml-1.5 text-xs text-cyan-600 dark:text-cyan-400">Save 17%</span>
              </button>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            {SELF_SERVE_PLANS.map((p) => {
              const current = plan === p.key
              const annualPrice = p.monthly * 10
              const fullYear = p.monthly * 12
              const perSeat = annual ? annualPrice : p.monthly
              return (
                <Card key={p.key} className={current ? 'border-primary' : ''}>
                  <CardHeader>
                    <CardTitle className="flex items-center justify-between">
                      <span>{p.label}</span>
                      {current && (
                        <Badge variant="default" className="gap-1">
                          <Check className="h-3 w-3" /> Current
                        </Badge>
                      )}
                    </CardTitle>
                    <CardDescription>{p.blurb}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div>
                      <div className="flex items-baseline gap-1">
                        <span className="text-3xl font-semibold">{formatUsd(perSeat)}</span>
                        <span className="text-sm text-muted-foreground">
                          / seat / {annual ? 'year' : 'month'}
                        </span>
                      </div>
                      {annual ? (
                        <p className="text-sm text-cyan-600 dark:text-cyan-400">
                          {formatUsd(annualPrice)}/yr vs {formatUsd(fullYear)} — 2 months free
                        </p>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          {formatUsd(annualPrice)}/yr on annual billing (2 months free)
                        </p>
                      )}
                    </div>
                    <Button
                      className="w-full"
                      variant={current ? 'outline' : 'default'}
                      disabled={current || checkoutMutation.isPending}
                      onClick={() => checkoutMutation.mutate(p.key)}
                    >
                      {current ? 'Active plan' : `Upgrade to ${p.label}`}
                    </Button>
                  </CardContent>
                </Card>
              )
            })}

            <Card>
              <CardHeader>
                <CardTitle>Enterprise</CardTitle>
                <CardDescription>
                  SSO/SAML, SCIM, compliance pack, BYO-KMS, cost attribution, custom SLAs.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-baseline gap-1">
                  <span className="text-3xl font-semibold">Custom</span>
                </div>
                <Button asChild className="w-full" variant="outline">
                  <a href="mailto:sales@almyty.com?subject=almyty%20Enterprise">
                    Contact sales
                    <ExternalLink className="ml-1.5 h-4 w-4" />
                  </a>
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {invoices && invoices.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Invoices</CardTitle>
            <CardDescription>Your most recent invoices</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {invoices.map((inv) => (
              <div
                key={inv.id}
                className="flex items-center justify-between border-b last:border-b-0 py-2 text-sm"
              >
                <div className="flex items-center gap-3">
                  <span className="font-medium">{inv.number || inv.id}</span>
                  <span className="text-muted-foreground">
                    {new Date(inv.created).toLocaleDateString()}
                  </span>
                  {inv.status && (
                    <Badge variant="outline" className="capitalize">
                      {inv.status}
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span>{formatMoney(inv.amountDue, inv.currency)}</span>
                  {inv.hostedInvoiceUrl && (
                    <a
                      href={inv.hostedInvoiceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline inline-flex items-center gap-1"
                    >
                      View <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
