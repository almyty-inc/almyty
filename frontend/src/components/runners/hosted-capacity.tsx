/**
 * The plan's hosted capacity on the Hosted tab (GET /environments/capacity):
 * for each limit, what is used and what the limit is, in plain words. Every
 * number comes from the server; none is written here.
 */
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'

import { environmentsApi } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'
import { RUNNER_HEARTBEAT_POLL_MS } from '@/pages/runners-shared'
import { formatMinutes } from './hosted-shared'

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
  minutesThisMonth: {
    used: number
    ceiling: number | null
    byClass: Array<{ resourceClass: string; used: number; included: number | null }>
  }
  alwaysOnHosted: Used
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

/** One plain sentence per size: used, included, and what is over. */
export function sizeLine(row: { resourceClass: string; used: number; included: number | null }, billed: boolean): string {
  const name = `${sizeName(row.resourceClass)} machines`
  if (row.included === null) return `${name}: ${formatMinutes(row.used)} used this month`
  const over = row.used - row.included
  if (over <= 0) {
    return row.included > 0
      ? `${name}: ${formatMinutes(row.used)} used of ${formatMinutes(row.included)} included this month`
      : `${name}: ${formatMinutes(row.used)} used this month`
  }
  const head = row.included > 0 ? `${formatMinutes(row.included)} included, ` : 'none included, '
  return `${name}: ${formatMinutes(row.used)} used this month (${head}${formatMinutes(over)} over${billed ? ', billed by the minute' : ''})`
}

/** The lines the card shows, in the order it shows them. */
export function capacityLines(c: HostedCapacityView): Array<{ key: string; text: string }> {
  const lines: Array<{ key: string; text: string }> = [
    { key: 'machines', text: `Machines running now: ${ofLimit(c.machinesRunning)}` },
    { key: 'workspaces', text: `Workspaces kept: ${ofLimit(c.workspacesKept)}` },
  ]
  for (const row of c.minutesThisMonth.byClass) lines.push({ key: `size-${row.resourceClass}`, text: sizeLine(row, c.billed) })
  if (c.minutesThisMonth.ceiling !== null) {
    lines.push({
      key: 'ceiling',
      text: `Monthly limit: ${formatMinutes(c.minutesThisMonth.used)} of ${formatMinutes(c.minutesThisMonth.ceiling)} used. Machines don't start once it is reached.`,
    })
  }
  if (c.alwaysOnHosted.limit !== null || c.alwaysOnHosted.used > 0) {
    lines.push({ key: 'always-on', text: `Always-on agents living on a hosted machine: ${ofLimit(c.alwaysOnHosted)}` })
  }
  return lines
}

/** The card above the environments list. Renders nothing until the server answers. */
export function HostedCapacityCard({ capacity }: { capacity: HostedCapacityView | undefined }) {
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
  return (
    <div className="rounded-md border bg-surround p-4 text-sm" data-testid="hosted-capacity">
      <p className="font-medium">{plan ? `What your ${plan} plan includes` : 'Hosted machine limits'}</p>
      <ul className="mt-2 space-y-1 text-muted-foreground">
        {capacityLines(capacity).map((l) => (
          <li key={l.key} data-testid={`hosted-capacity-${l.key}`}>
            {l.text}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">
        A machine counts from when it starts until it parks itself, including the idle minutes before it parks.
      </p>
    </div>
  )
}
