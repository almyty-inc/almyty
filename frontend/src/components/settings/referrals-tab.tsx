import { useQuery } from '@tanstack/react-query'
import { Copy, Gift } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { referralsApi } from '@/lib/api'
import { useCopy } from '@/lib/clipboard'

const STATUS_LABELS: Record<string, { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }> = {
  pending: { label: 'Pending', variant: 'secondary' },
  qualified: { label: 'Qualified', variant: 'default' },
  rewarded: { label: 'Rewarded', variant: 'default' },
  pending_review: { label: 'Pending review', variant: 'outline' },
}

export function ReferralsTab() {
  const copy = useCopy()

  const codeQuery = useQuery({ queryKey: ['referrals', 'code'], queryFn: referralsApi.getCode })
  const statsQuery = useQuery({ queryKey: ['referrals', 'stats'], queryFn: referralsApi.getStats })
  const listQuery = useQuery({ queryKey: ['referrals', 'list'], queryFn: referralsApi.list })

  const stats = statsQuery.data

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Gift className="h-5 w-5" />
            Invite friends, earn free pro time
          </CardTitle>
          <CardDescription>
            Share your link. When someone signs up they get a month of pro; when their
            organization goes live you earn free pro days too.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {codeQuery.isLoading ? (
            <Skeleton className="h-10 w-full" />
          ) : codeQuery.isError ? (
            <p className="text-sm text-muted-foreground">
              Referral links are not available for your organization.
            </p>
          ) : (
            <div className="flex items-center gap-2">
              <Input readOnly value={codeQuery.data?.link ?? ''} className="font-mono text-sm" />
              <Button
                variant="outline"
                onClick={() => codeQuery.data && copy(codeQuery.data.link, 'Referral link')}
              >
                <Copy className="h-4 w-4 mr-2" />
                Copy
              </Button>
            </div>
          )}

          {stats && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-2">
              <StatBlock label="Invited" value={stats.invited} />
              <StatBlock label="Qualified" value={stats.qualified} />
              <StatBlock label="Rewarded" value={stats.rewarded} />
              <StatBlock
                label="Reward days"
                value={stats.totalRewardDays}
                hint={stats.accruedRewardDays > 0 ? `${stats.accruedRewardDays} banked until you upgrade to pro` : undefined}
              />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your referrals</CardTitle>
          <CardDescription>
            Referrals qualify when the invited organization creates a gateway and runs an agent.
            Flagged signups stay in review and do not reward automatically.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {listQuery.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : !listQuery.data?.length ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No referrals yet — share your link to get started.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Signed up</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Qualified</TableHead>
                  <TableHead className="text-right">Reward days</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {listQuery.data.map((referral) => {
                  const status = STATUS_LABELS[referral.status] ?? STATUS_LABELS.pending
                  return (
                    <TableRow key={referral.id}>
                      <TableCell>{new Date(referral.createdAt).toLocaleDateString()}</TableCell>
                      <TableCell>
                        <Badge variant={status.variant}>{status.label}</Badge>
                      </TableCell>
                      <TableCell>
                        {referral.qualifiedAt
                          ? new Date(referral.qualifiedAt).toLocaleDateString()
                          : '—'}
                      </TableCell>
                      <TableCell className="text-right">{referral.rewardDays}</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function StatBlock({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-2xl font-heading font-bold">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
      {hint && <div className="text-xs text-muted-foreground mt-1">{hint}</div>}
    </div>
  )
}
