/**
 * /settings/approvals/rules/new and /settings/approvals/rules/:ruleId --
 * an amount rule: "ask before “Create refund” when amount is over 500".
 * Free for every organization. One approval decides it; sign-off in
 * several steps is the Business approval-policy feature.
 */
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ShieldCheck } from 'lucide-react'

import { Field, FormPage, FormSection } from '@/components/layout/form-page'
import { AmountRuleFields, type AmountRuleErrors, type AmountRuleValue } from '@/components/settings/approval-amount-rule'
import { APPROVAL_POLICIES_PATH } from '@/components/settings/approval-policy-form'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { Switch } from '@/components/ui/switch'
import { VisibilityField } from '@/components/ui/visibility-field'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import { approvalRulesApi, type ApprovalPolicy, type UpsertAmountRule } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'
import { pluralized } from '@/lib/utils'

interface RuleForm extends AmountRuleValue {
  name: string
  teamId: string | null
  enabled: boolean
}

function formOf(rule: ApprovalPolicy | null): RuleForm {
  return {
    name: rule?.name ?? '',
    teamId: rule?.teamId ?? null,
    enabled: rule?.enabled ?? true,
    toolId: rule?.trigger?.toolId ?? '',
    argument: rule?.trigger?.argument ?? '',
    op: rule?.trigger?.op ?? 'gt',
    amount: rule?.trigger ? String(rule.trigger.amount) : '',
  }
}

/** What is missing, per field, or nothing. */
export function ruleErrors(form: RuleForm): AmountRuleErrors & { name?: string } {
  const errors: AmountRuleErrors & { name?: string } = {}
  if (!form.name.trim()) errors.name = 'Give the rule a name'
  if (!form.toolId) errors.toolId = 'Choose the tool'
  else if (!form.argument) errors.argument = 'Choose the number to compare'
  const amount = Number(form.amount)
  if (form.amount.trim() === '' || !Number.isFinite(amount) || amount < 0) errors.amount = 'Enter an amount of 0 or more'
  return errors
}

export function ApprovalRuleForm({
  rule,
  isSaving,
  onSubmit,
}: {
  rule: ApprovalPolicy | null
  isSaving: boolean
  onSubmit: (data: UpsertAmountRule) => Promise<unknown>
}) {
  const { currentOrganization } = useOrganizationStore()
  const [initial] = useState(() => formOf(rule))
  const [form, setForm] = useState<RuleForm>(initial)
  const [submitted, setSubmitted] = useState(false)
  const guard = useLeaveGuard(JSON.stringify(form) !== JSON.stringify(initial))
  const errors = submitted ? ruleErrors(form) : {}
  const set = (patch: Partial<RuleForm>) => setForm((f) => ({ ...f, ...patch }))
  const steps = rule?.steps ?? []
  const severalSteps = steps.length > 1 || steps.some((s) => s.minApprovals > 1 || s.approverRole !== '*')

  const submit = async () => {
    setSubmitted(true)
    if (Object.keys(ruleErrors(form)).length > 0) return
    try {
      await onSubmit({
        name: form.name.trim(),
        teamId: form.teamId,
        enabled: form.enabled,
        trigger: { kind: 'tool_amount', toolId: form.toolId, argument: form.argument, op: form.op, amount: Number(form.amount) },
      })
    } catch {
      return
    }
    guard.leave(APPROVAL_POLICIES_PATH)
  }

  return (
    <FormPage
      title={rule ? 'Edit approval rule' : 'Ask before a large amount'}
      description="Ask a person before a tool runs with an amount over a limit. Calls under it run without asking."
      back={{ to: APPROVAL_POLICIES_PATH, label: 'Approvals' }}
      guard={guard}
      onSubmit={submit}
      submitLabel={rule ? 'Save changes' : 'Create rule'}
      submitting={isSaving}
    >
      <FormSection>
        <Field id="rule-name" label="Name" error={errors.name}>
          <Input id="rule-name" placeholder="Refunds over 500" value={form.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
      </FormSection>

      <FormSection title="When to ask">
        <AmountRuleFields value={form} onChange={set} errors={errors} />
      </FormSection>

      <FormSection title="Who it applies to">
        <VisibilityField
          organizationId={currentOrganization?.id ?? ''}
          options={['org', 'team']}
          label="Which calls it covers"
          descriptions={{
            org: 'Every call to the tool: any agent, app or connected client.',
            team: "Only calls made by the team's agents.",
          }}
          value={{ visibility: form.teamId ? 'team' : 'org', teamId: form.teamId }}
          onChange={(next) => set({ teamId: next.visibility === 'team' ? next.teamId : null })}
        />
      </FormSection>

      <FormSection title="Who approves">
        <p className="text-sm text-muted-foreground">
          {severalSteps
            ? `Signed off in ${steps.length === 1 ? 'one step' : pluralized(steps.length, 'step')}, as set in the Business approval policies.`
            : "One approval from an owner or an admin decides it (for a team's rule, the team's lead too). Sign-off in several steps comes with the Business plan."}
        </p>
        <div className="flex items-center justify-between gap-4 rounded-md border p-3">
          <div>
            <Label htmlFor="rule-enabled">On</Label>
            <p className="text-xs text-muted-foreground">A rule that is off asks nobody.</p>
          </div>
          <Switch id="rule-enabled" checked={form.enabled} onCheckedChange={(v) => set({ enabled: v })} />
        </div>
      </FormSection>
    </FormPage>
  )
}

export function ApprovalRulePage() {
  const { ruleId } = useParams<{ ruleId?: string }>()
  const queryClient = useQueryClient()
  const { success, error } = useNotifications()
  useEffect(() => {
    document.title = `${ruleId ? 'Edit approval rule' : 'Ask before a large amount'} | almyty`
    return () => {
      document.title = 'almyty'
    }
  }, [ruleId])

  const ruleQuery = useQuery<ApprovalPolicy>({
    queryKey: ['approval-rules', ruleId],
    queryFn: () => approvalRulesApi.getById(ruleId!),
    enabled: !!ruleId,
  })
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['approval-rules'] })
  const save = useMutation({
    mutationFn: (data: UpsertAmountRule) => (ruleId ? approvalRulesApi.update(ruleId, data) : approvalRulesApi.create(data)),
    onSuccess: async () => {
      success(ruleId ? 'Rule saved' : 'Rule created', 'Calls over the amount now wait for a person.')
      await invalidate()
    },
    onError: (err: unknown) => error('Could not save the rule', getApiErrorMessage(err, 'Please try again.')),
  })

  if (!ruleId) return <ApprovalRuleForm rule={null} isSaving={save.isPending} onSubmit={(d) => save.mutateAsync(d)} />
  if (ruleQuery.isLoading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <LoadingSpinner size="md" />
      </div>
    )
  }
  if (ruleQuery.isError || !ruleQuery.data) {
    return (
      <EmptyState
        variant="panel"
        icon={ShieldCheck}
        title="Approval rule not found"
        description="It may have been deleted. Settings > Advanced > Approvals lists the rules that exist."
      />
    )
  }
  return <ApprovalRuleForm key={ruleQuery.data.id} rule={ruleQuery.data} isSaving={save.isPending} onSubmit={(d) => save.mutateAsync(d)} />
}

export default ApprovalRulePage
