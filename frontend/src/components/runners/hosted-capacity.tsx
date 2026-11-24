/**
 * The plan's hosted capacity on the Hosted tab (GET /environments/capacity):
 * for each limit, what is used and what the limit is, in plain words. Every
 * number comes from the server; none is written here.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { environmentsApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useOrganizationRole } from '@/hooks/use-organization-role'
import { useOrganizationStore } from '@/store/organization'
import { useNotifications } from '@/store/app'
import { RUNNER_HEARTBEAT_POLL_MS } from '@/pages/runners-shared'
import { formatMinutes } from './hosted-shared'
import { formatCost } from '@/lib/format'

interface Used {
  used: number
  /** Null: no limit. */
  limit: number | null
}

export interface HostedCapacityView {
  /** Null where the install sells no plans. */
  plan: string | null
  hostedEnvironments: boolean
  billed: boolean
  machinesRunning: Used
  workspacesKept: Used
  /** The sizes the plan allows; null or absent: every size the install offers. */
  resourceClasses?: string[] | null
  minutesThisMonth: {
    used: number
    ceiling: number | null
    byClass: Array<{ resourceClass: string; used: number; included: number | null; usdPerMinute?: number | null }>
  }
  /** Dollars used beyond the included hours this month, and the plan's dollar limit (null: none). */
  spendThisMonth?: { usd: number; ceilingUsd: number | null }
  alwaysOnHosted: Used
  /** The limits an organization may lower for itself, the plan's and its own (absent: older server). */
  ownLimits?: OwnLimitsView
}

export const OWN_LIMIT_FIELDS = ['maxConcurrentRunners', 'maxWorkspaces', 'monthlyCeilingUsd'] as const
export type OwnLimitField = (typeof OWN_LIMIT_FIELDS)[number]
/** Null: no number (no limit on the plan; on the organization's own row, follow the plan). */
export type OwnLimits = Record<OwnLimitField, number | null>

export interface OwnLimitsView {
  /** False where own limits do not apply (no plan on this install). */
  available: boolean
  plan: OwnLimits
  own: OwnLimits
}

export function useHostedCapacity() {
  const orgId = useOrganizationStore((s) => s.currentOrganization?.id)
  return useQuery<HostedCapacityView>({
    queryKey: ['environment-capacity', orgId],
    queryFn: () => environmentsApi.capacity(),
    enabled: !!orgId,
    refetchInterval: RUNNER_HEARTBEAT_POLL_MS,
  })
}

const PLAN_NAME: Record<string, string> = { free: 'Free', pro: 'Pro', business: 'Business', enterprise: 'Enterprise' }

function ofLimit({ used, limit }: Used): string {
  return limit === null ? `${used}, no limit` : `${used} of ${limit}`
}

function sizeName(resourceClass: string): string {
  return resourceClass.charAt(0).toUpperCase() + resourceClass.slice(1)
}

/** Spend reads as every cost does ("$12.40", "<$0.01"); zero is "$0.00" here, a real amount. */
const USD = { format: (dollars: number) => formatCost(dollars, { empty: '$0.00' }) }
/** A per-minute price, not spend: it keeps the fraction of a cent it is set in. */
const USD_PER_MINUTE = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 })

/** One plain sentence per size: used, included, and what is over. */
export function sizeLine(
  row: { resourceClass: string; used: number; included: number | null; usdPerMinute?: number | null },
  billed: boolean,
): string {
  const name = `${sizeName(row.resourceClass)} machines`
  if (row.included === null) return `${name}: ${formatMinutes(row.used)} used this month`
  const over = row.used - row.included
  if (over <= 0) {
    return row.included > 0
      ? `${name}: ${formatMinutes(row.used)} used of ${formatMinutes(row.included)} included this month`
      : `${name}: ${formatMinutes(row.used)} used this month`
  }
  const head = row.included > 0 ? `${formatMinutes(row.included)} included, ` : 'none included, '
  const billing = !billed ? '' : row.usdPerMinute ? `, billed at ${USD_PER_MINUTE.format(row.usdPerMinute)} a minute` : ', billed by the minute'
  return `${name}: ${formatMinutes(row.used)} used this month (${head}${formatMinutes(over)} over${billing})`
}

/** Sizes as a list in words: "Small and Medium", "Small, Medium and Large". */
function sizeList(classes: string[]): string {
  const names = classes.map(sizeName)
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** The lines the card shows, in the order it shows them. */
export function capacityLines(c: HostedCapacityView): Array<{ key: string; text: string }> {
  const lines: Array<{ key: string; text: string }> = [
    { key: 'machines', text: `Machines running now: ${ofLimit(c.machinesRunning)}` },
    { key: 'workspaces', text: `Workspaces kept: ${ofLimit(c.workspacesKept)}` },
  ]
  if (c.resourceClasses && c.resourceClasses.length > 0) {
    lines.push({ key: 'sizes', text: `Machine sizes: ${sizeList(c.resourceClasses)}` })
  }
  for (const row of c.minutesThisMonth.byClass) lines.push({ key: `size-${row.resourceClass}`, text: sizeLine(row, c.billed) })
  if (c.minutesThisMonth.ceiling !== null) {
    lines.push({
      key: 'ceiling',
      text: `Monthly limit: ${formatMinutes(c.minutesThisMonth.used)} of ${formatMinutes(c.minutesThisMonth.ceiling)} used. Machines don't start once it is reached.`,
    })
  }
  if (c.spendThisMonth && c.spendThisMonth.ceilingUsd !== null) {
    lines.push({
      key: 'spend',
      text: `Monthly spending limit: ${USD.format(c.spendThisMonth.usd)} of ${USD.format(c.spendThisMonth.ceilingUsd)} used beyond the included hours. Machines don't start once it is reached.`,
    })
  }
  if (c.alwaysOnHosted.limit !== null || c.alwaysOnHosted.used > 0) {
    lines.push({ key: 'always-on', text: `Always-on agents living on a hosted machine: ${ofLimit(c.alwaysOnHosted)}` })
  }
  return lines
}

/** Which card line each limit an organization may lower sits on. */
const EDITABLE_LINE: Record<string, OwnLimitField> = {
  machines: 'maxConcurrentRunners',
  workspaces: 'maxWorkspaces',
  spend: 'monthlyCeilingUsd',
}

const FIELD_LABEL: Record<OwnLimitField, string> = {
  maxConcurrentRunners: 'Machines running at once',
  maxWorkspaces: 'Workspaces kept',
  monthlyCeilingUsd: 'Monthly spending limit, in dollars',
}

type Draft = Record<OwnLimitField, string>

function planText(field: OwnLimitField, plan: number | null): string {
  if (plan === null) return 'Your plan sets no limit.'
  return `Your plan allows up to ${field === 'monthlyCeilingUsd' ? USD.format(plan) : plan}.`
}

/**
 * What a draft saves: an empty field, or the plan's own number, follows the
 * plan (null); anything else is the organization's lower limit. Returns the
 * problem with each field the server would refuse, in words.
 */
export function limitsFromDraft(
  draft: Draft,
  plan: OwnLimits,
): { limits: OwnLimits; errors: Partial<Record<OwnLimitField, string>> } {
  const limits: OwnLimits = { maxConcurrentRunners: null, maxWorkspaces: null, monthlyCeilingUsd: null }
  const errors: Partial<Record<OwnLimitField, string>> = {}
  for (const field of OWN_LIMIT_FIELDS) {
    const raw = draft[field].trim()
    if (raw === '') continue
    const whole = field !== 'monthlyCeilingUsd'
    // Whole machines and workspaces; dollars to the cent.
    if (!(whole ? /^\d+$/ : /^\d+(\.\d{1,2})?$/).test(raw)) {
      errors[field] = whole ? 'Enter a whole number, 0 or more.' : 'Enter an amount in dollars, 0 or more.'
      continue
    }
    const n = Number(raw)
    const most = plan[field]
    if (most !== null && n > most) {
      errors[field] = `${planText(field, most)} You can only lower it.`
      continue
    }
    limits[field] = most !== null && n === most ? null : n
  }
  return { limits, errors }
}

function draftFrom(own: OwnLimits, plan: OwnLimits): Draft {
  const value = (f: OwnLimitField) => {
    const n = own[f] ?? plan[f]
    return n === null ? '' : String(n)
  }
  return { maxConcurrentRunners: value('maxConcurrentRunners'), maxWorkspaces: value('maxWorkspaces'), monthlyCeilingUsd: value('monthlyCeilingUsd') }
}

/** One limit's field, inline under its line on the card. */
function LimitField({
  field,
  value,
  plan,
  error,
  onChange,
}: {
  field: OwnLimitField
  value: string
  plan: number | null
  error?: string
  onChange: (value: string) => void
}) {
  const id = `hosted-limit-${field}`
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      <Label htmlFor={id} className="sr-only">
        {FIELD_LABEL[field]}
      </Label>
      <Input
        id={id}
        type="number"
        min={0}
        step={field === 'monthlyCeilingUsd' ? '0.01' : '1'}
        className="h-8 w-28"
        value={value}
        placeholder={plan === null ? 'No limit' : String(plan)}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!!error}
        data-testid={id}
      />
      <span className={error ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>{error ?? planText(field, plan)}</span>
    </div>
  )
}

/** The card above the environments list. Renders nothing until the server answers. */
export function HostedCapacityCard({ capacity }: { capacity: HostedCapacityView | undefined }) {
  const { canManage } = useOrganizationRole()
  const queryClient = useQueryClient()
  const { success, error: notifyError } = useNotifications()
  const [draft, setDraft] = useState<Draft | null>(null)
  const save = useMutation({
    mutationFn: (limits: OwnLimits) => environmentsApi.setLimits(limits),
    onSuccess: () => {
      success('Limits saved')
      setDraft(null)
      queryClient.invalidateQueries({ queryKey: ['environment-capacity'] })
    },
    onError: (err: unknown) => notifyError("Couldn't save the limits", getApiErrorMessage(err)),
  })

  if (!capacity) return null
  const plan = capacity.plan ? PLAN_NAME[capacity.plan] ?? capacity.plan : null
  if (!capacity.hostedEnvironments) {
    return (
      <div className="rounded-md border bg-surround p-4 text-sm" data-testid="hosted-capacity">
        <p className="font-medium">Hosted machines are not part of {plan ? `the ${plan} plan` : 'your plan'}.</p>
        <p className="mt-1 text-muted-foreground">
          Register a machine of your own on the Your machines tab, or{' '}
          <Link to="/settings/billing" className="text-primary hover:underline">
            see plans
          </Link>
          .
        </p>
      </div>
    )
  }
  const own = capacity.ownLimits?.available ? capacity.ownLimits : null
  const canLower = canManage && !!own
  const lowered = !!own && OWN_LIMIT_FIELDS.some((f) => own.own[f] !== null)
  const lines = capacityLines(capacity)
  // While editing, the spending limit has a line even where none is set yet.
  if (draft && !lines.some((l) => l.key === 'spend')) {
    const at = lines.findIndex((l) => l.key === 'always-on')
    const spend = { key: 'spend', text: 'Monthly spending limit beyond the included hours: none' }
    if (at < 0) lines.push(spend)
    else lines.splice(at, 0, spend)
  }
  const checked = draft && own ? limitsFromDraft(draft, own.plan) : null
  const invalid = !!checked && Object.keys(checked.errors).length > 0
  return (
    <div className="rounded-md border bg-surround p-4 text-sm" data-testid="hosted-capacity">
      <p className="font-medium">{plan ? `What your ${plan} plan includes` : 'Hosted machine limits'}</p>
      <ul className="mt-2 space-y-1 text-muted-foreground">
        {lines.map((l) => {
          const field = EDITABLE_LINE[l.key]
          return (
            <li key={l.key} data-testid={`hosted-capacity-${l.key}`}>
              {l.text}
              {draft && own && field && (
                <LimitField
                  field={field}
                  value={draft[field]}
                  plan={own.plan[field]}
                  error={checked?.errors[field]}
                  onChange={(value) => setDraft({ ...draft, [field]: value })}
                />
              )}
            </li>
          )
        })}
      </ul>
      {lowered && !draft && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="hosted-capacity-lowered">
          Your organization has set some of these lower than the plan allows.
        </p>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        A machine counts from when it starts until it parks itself, including the idle minutes before it parks.
      </p>
      {canLower && own && !draft && (
        <Button variant="outline" size="sm" className="mt-3" onClick={() => setDraft(draftFrom(own.own, own.plan))} data-testid="hosted-limits-edit">
          Lower limits
        </Button>
      )}
      {draft && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={invalid || save.isPending} onClick={() => checked && save.mutate(checked.limits)} data-testid="hosted-limits-save">
            {save.isPending ? 'Saving...' : 'Save'}
          </Button>
          <Button variant="outline" size="sm" disabled={save.isPending} onClick={() => setDraft(null)}>
            Cancel
          </Button>
          {lowered && (
            <Button
              variant="ghost"
              size="sm"
              disabled={save.isPending}
              onClick={() => save.mutate({ maxConcurrentRunners: null, maxWorkspaces: null, monthlyCeilingUsd: null })}
              data-testid="hosted-limits-reset"
            >
              Use the plan's limits
            </Button>
          )}
          <span className="text-xs text-muted-foreground">Leave a field empty to use the plan's limit.</span>
        </div>
      )}
    </div>
  )
}