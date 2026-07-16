/* PlanComparison — the feature matrix a user sees in Settings -> Billing so
 * they can tell exactly what their tier includes and what they are missing.
 *
 * Rows are the notable features (from FEATURE_MATRIX), columns are the four
 * tiers. A check means the tier includes the feature; a lock means it does not.
 * The user's current tier column is highlighted.
 */
import { Check, Lock } from 'lucide-react'

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import {
  PLANS,
  PLAN_ORDER,
  FEATURE_MATRIX,
  planHasFeature,
  toPlanKey,
  type PlanKey,
} from '@/lib/plan-catalog'

export function PlanComparison({ currentPlan }: { currentPlan?: string }) {
  const current: PlanKey = toPlanKey(currentPlan)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Compare plans</CardTitle>
        <CardDescription>
          What each tier includes. Your current plan is highlighted.
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full text-sm border-collapse min-w-[560px]">
          <thead>
            <tr className="border-b">
              <th className="text-left font-medium text-muted-foreground py-2 pr-4">Feature</th>
              {PLAN_ORDER.map((key) => {
                const meta = PLANS[key]
                const isCurrent = key === current
                return (
                  <th
                    key={key}
                    className={cn(
                      'py-2 px-3 text-center align-bottom',
                      isCurrent && 'bg-primary/5 rounded-t-md',
                    )}
                  >
                    <div className="flex flex-col items-center gap-1">
                      <span className={cn('font-semibold', isCurrent && 'text-primary')}>
                        {meta.label}
                      </span>
                      <span className="text-xs text-muted-foreground">{meta.price}</span>
                      {isCurrent && (
                        <Badge variant="default" className="text-[10px] gap-1">
                          <Check className="h-3 w-3" /> Current
                        </Badge>
                      )}
                    </div>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {FEATURE_MATRIX.map((row) => (
              <tr key={row.label} className="border-b last:border-0">
                <td className="py-2 pr-4 text-foreground">{row.label}</td>
                {PLAN_ORDER.map((key) => {
                  const included = planHasFeature(key, row)
                  const isCurrent = key === current
                  return (
                    <td
                      key={key}
                      className={cn('py-2 px-3 text-center', isCurrent && 'bg-primary/5')}
                      aria-label={`${row.label} ${included ? 'included' : 'not included'} in ${PLANS[key].label}`}
                    >
                      {included ? (
                        <Check
                          className="h-4 w-4 text-emerald-500 inline"
                          aria-hidden="true"
                          data-testid={`incl-${key}`}
                        />
                      ) : (
                        <Lock
                          className="h-3.5 w-3.5 text-muted-foreground/50 inline"
                          aria-hidden="true"
                          data-testid={`lock-${key}`}
                        />
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  )
}
