/**
 * "Ask before large amounts" on Settings > Advanced > Approvals: the
 * organization's amount rules, free for everyone. Each reads as a sentence
 * ("Ask before “Create refund” when amount is over 500").
 */
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, Scale, Trash2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { approvalRulesApi, type ApprovalPolicy } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { describeAmountRule } from '@/lib/approval-rules'
import { useNotifications } from '@/store/app'
import { quotedToolName, useRuleTools } from './approval-amount-rule'
import { APPROVAL_POLICIES_PATH } from './approval-policy-form'

export function AmountRulesCard() {
  const queryClient = useQueryClient()
  const { success, error } = useNotifications()
  const { confirm, dialog } = useConfirm()
  const { tools } = useRuleTools()
  const { data: rules, isLoading } = useQuery<ApprovalPolicy[]>({
    queryKey: ['approval-rules'],
    queryFn: () => approvalRulesApi.list(),
  })
  const remove = useMutation({
    mutationFn: (id: string) => approvalRulesApi.delete(id),
    onSuccess: async () => {
      success('Rule deleted', 'Calls to that tool run without asking again.')
      await queryClient.invalidateQueries({ queryKey: ['approval-rules'] })
    },
    onError: (err: unknown) => error('Could not delete the rule', getApiErrorMessage(err, 'Please try again.')),
  })

  const sentence = (rule: ApprovalPolicy) =>
    rule.trigger
      ? describeAmountRule({ ...rule.trigger, toolName: quotedToolName(tools.find((t) => t.id === rule.trigger!.toolId), rule.trigger.toolName) })
      : ''

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Scale className="h-5 w-5 text-primary" /> Ask before large amounts
          </CardTitle>
          <CardDescription>
            A person approves a tool call over an amount before it runs, whatever the agent was told. Calls under the
            amount run without asking.
          </CardDescription>
        </div>
        <Button asChild className="shrink-0">
          <Link to="/settings/approvals/rules/new">
            <Plus className="mr-1 h-4 w-4" /> New rule
          </Link>
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="py-6 text-center text-muted-foreground">Loading rules…</p>
        ) : !rules?.length ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No rules yet. For example: ask before refunds over 500.
          </p>
        ) : (
          <ul className="divide-y" data-testid="amount-rules">
            {rules.map((rule) => (
              <li key={rule.id} className="flex items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{rule.name}</p>
                  <p className="text-sm text-muted-foreground">{sentence(rule)}</p>
                </div>
                {!rule.enabled && <Badge variant="outline" className="text-muted-foreground">Off</Badge>}
                <Button variant="ghost" size="icon" asChild>
                  <Link to={`${APPROVAL_POLICIES_PATH}/rules/${rule.id}`} aria-label={`Edit ${rule.name}`}>
                    <Pencil className="h-4 w-4" />
                  </Link>
                </Button>
                <Button variant="ghost" size="icon" aria-label={`Delete ${rule.name}`} onClick={async () => {
                    const ok = await confirm({
                      title: 'Delete this rule?',
                      description: `"${rule.name}" goes, and calls to that tool run without asking.`,
                      confirmLabel: 'Delete rule',
                      destructive: true,
                    })
                    if (ok) remove.mutate(rule.id)
                  }}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      {dialog}
    </Card>
  )
}
