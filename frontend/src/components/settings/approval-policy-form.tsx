/**
 * The approval policy form, as a page: /settings/approvals/policies/new
 * creates, /settings/approvals/policies/:policyId edits.
 *
 * Mirrors the real backend DTO (`UpsertPolicyDto` -> ApprovalPolicy entity):
 * name, description, optional team scoping, priority, enabled, an ANDed list
 * of match conditions ({ attr, op, value }) that decide WHEN the policy
 * fires, and an ordered list of sequential quorum steps ({ name,
 * approverRole, minApprovals }) that decide WHO must sign off.
 */
import { useForm, useFieldArray } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import * as z from 'zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { Plus, ShieldCheck, Trash2 } from 'lucide-react'

import { Field, FormPage, FormSection } from '@/components/layout/form-page'
import { EntitlementGate } from '@/components/entitlement-gate'
import { UpgradePrompt } from '@/components/plan-indicator'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import {
  approvalPoliciesApi,
  type ApprovalPolicy,
  type ApprovalStep,
  type UpsertApprovalPolicy,
} from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'
import { Disclosure } from '@/components/ui/disclosure'
import { VisibilityField } from '@/components/ui/visibility-field'

export const APPROVAL_POLICIES_PATH = '/settings/approvals'

// Mirrors ApprovalMatchCondition['op'] on the backend entity.
const MATCH_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'nin'] as const

const OP_LABELS: Record<(typeof MATCH_OPS)[number], string> = {
  eq: 'equals',
  neq: 'not equals',
  gt: 'greater than',
  gte: 'greater or equal',
  lt: 'less than',
  lte: 'less or equal',
  in: 'in list',
  nin: 'not in list',
}

const conditionSchema = z.object({
  attr: z.string().min(1, 'Attribute is required'),
  op: z.enum(MATCH_OPS),
  // Raw string in the form; parsed to number/array/bool/string on submit.
  value: z.string(),
})

const stepSchema = z.object({
  name: z.string().min(1, 'Step name is required'),
  approverRole: z.string().min(1, 'Approver role is required'),
  minApprovals: z
    .number({ message: 'Must be a number' })
    .int()
    .min(1, 'Must be at least 1'),
})

export const approvalPolicySchema = z.object({
  name: z.string().min(1, 'Name is required').max(128, 'Max 128 characters'),
  description: z.string().optional(),
  teamId: z.string().optional(),
  priority: z.number({ message: 'Must be a number' }).int(),
  enabled: z.boolean(),
  match: z.array(conditionSchema),
  steps: z.array(stepSchema).min(1, 'Add at least one approval step'),
})

export type ApprovalPolicyFormValues = z.infer<typeof approvalPolicySchema>

/**
 * Coerce a raw form string into the JSON value the matcher expects. Numbers
 * parse to numbers, `in`/`nin` split on commas into an array, true/false to
 * booleans, everything else stays a string.
 */
function coerceValue(op: string, raw: string): unknown {
  const trimmed = raw.trim()
  if (op === 'in' || op === 'nin') {
    return trimmed
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (s !== '' && !isNaN(Number(s)) ? Number(s) : s))
  }
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed !== '' && !isNaN(Number(trimmed))) return Number(trimmed)
  return trimmed
}

/** Render a stored matcher value back into an editable form string. */
function valueToString(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ')
  if (value === null || value === undefined) return ''
  return String(value)
}

export interface ApprovalPolicyFormProps {
  /** The policy being edited, or null when creating a new one. */
  policy: ApprovalPolicy | null
  isSaving: boolean
  /** Resolves once saved; the form then returns to the policies list. */
  onSubmit: (data: UpsertApprovalPolicy) => unknown
}

export function ApprovalPolicyForm({ policy, isSaving, onSubmit }: ApprovalPolicyFormProps) {
  const { currentOrganization } = useOrganizationStore()
  const form = useForm<ApprovalPolicyFormValues>({
    resolver: zodResolver(approvalPolicySchema),
    defaultValues: {
      name: policy?.name ?? '',
      description: policy?.description ?? '',
      teamId: policy?.teamId ?? '',
      priority: policy?.priority ?? 0,
      enabled: policy?.enabled ?? true,
      match: (policy?.match ?? []).map((c) => ({
        attr: c.attr,
        op: c.op,
        value: valueToString(c.value),
      })),
      steps:
        policy?.steps && policy.steps.length > 0
          ? policy.steps.map((s) => ({ ...s }))
          : [{ name: '', approverRole: '*', minApprovals: 1 }],
    },
  })
  const guard = useLeaveGuard(form.formState.isDirty)

  const matchArray = useFieldArray({ control: form.control, name: 'match' })

  const submit = async (data: ApprovalPolicyFormValues) => {
    const payload: UpsertApprovalPolicy = {
      name: data.name.trim(),
      description: data.description?.trim() ? data.description.trim() : null,
      teamId: data.teamId?.trim() ? data.teamId.trim() : null,
      priority: data.priority,
      enabled: data.enabled,
      match: data.match.map((c) => ({
        attr: c.attr.trim(),
        op: c.op,
        value: coerceValue(c.op, c.value),
      })),
      steps: data.steps.map((s) => ({
        name: s.name.trim(),
        approverRole: s.approverRole.trim(),
        minApprovals: s.minApprovals,
      })),
    }
    try {
      await onSubmit(payload)
    } catch {
      // The mutation's onError already said why; stay on the form.
      return
    }
    guard.leave(APPROVAL_POLICIES_PATH)
  }

  const errors = form.formState.errors

  return (
    <FormPage
      title={policy ? 'Edit approval policy' : 'New approval policy'}
      description="Decide when to ask for approval, and who must sign off, in order. A request must clear every step before it is approved."
      back={{ to: APPROVAL_POLICIES_PATH, label: 'Approval policies' }}
      guard={guard}
      onSubmit={form.handleSubmit(submit)}
      submitLabel={policy ? 'Save changes' : 'Create policy'}
      submitting={isSaving}
    >
      <FormSection>
        <Field id="policy-name" label="Name" error={errors.name?.message}>
          <Input placeholder="Refunds over $1,000" {...form.register('name')} />
        </Field>
        <Field id="policy-description" label="Description">
          <Textarea placeholder="Why this policy exists (optional)" {...form.register('description')} />
        </Field>
        <VisibilityField
          organizationId={currentOrganization?.id ?? ''}
          options={['org', 'team']}
          label="Which agents it applies to"
          descriptions={{
            org: 'Requests from every agent in the organization.',
            team: "Only requests from the team's agents.",
          }}
          value={{ visibility: form.watch('teamId') ? 'team' : 'org', teamId: form.watch('teamId') || null }}
          onChange={(next) => form.setValue('teamId', next.teamId ?? '', { shouldDirty: true })}
        />
        <div className="flex items-center justify-between gap-4 rounded-md border p-3">
          <div>
            <Label htmlFor="policy-enabled">Enabled</Label>
            <p className="text-xs text-muted-foreground">
              Only policies that are on are checked when an agent asks.
            </p>
          </div>
          <Switch
            id="policy-enabled"
            checked={form.watch('enabled')}
            onCheckedChange={(v) => form.setValue('enabled', v, { shouldDirty: true })}
          />
        </div>
      </FormSection>

      <FormSection
        title="When it applies"
        description={
          <>
            An agent asks for approval when its instructions tell it to. These conditions pick which of those
            requests this policy covers, and all of them must be true. Leave it empty to cover every request. To
            always ask before an action over a set amount, whatever the agent was told, add a rule under{' '}
            <Link to={APPROVAL_POLICIES_PATH} className="underline">Ask before large amounts</Link>.
          </>
        }
      >
        {matchArray.fields.length === 0 && (
          <p className="text-sm italic text-muted-foreground">
            No conditions, so this policy covers every request.
          </p>
        )}
        {matchArray.fields.map((field, i) => (
          <div key={field.id} className="flex flex-col gap-2 sm:flex-row sm:items-start">
            <div className="flex-1">
              <Input
                aria-label={`Condition ${i + 1} attribute`}
                aria-invalid={errors.match?.[i]?.attr ? true : undefined}
                placeholder="attr (e.g. amount, toolName)"
                {...form.register(`match.${i}.attr` as const)}
              />
              {errors.match?.[i]?.attr && (
                <p className="mt-1 text-sm text-destructive">{errors.match[i]?.attr?.message}</p>
              )}
            </div>
            <Select
              value={form.watch(`match.${i}.op`)}
              onValueChange={(v) => form.setValue(`match.${i}.op`, v as any, { shouldDirty: true })}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label={`Condition ${i + 1} operator`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MATCH_OPS.map((op) => (
                  <SelectItem key={op} value={op}>
                    {OP_LABELS[op]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex flex-1 gap-2">
              <Input
                aria-label={`Condition ${i + 1} value`}
                placeholder="value (separate a list with commas)"
                {...form.register(`match.${i}.value` as const)}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove condition ${i + 1}`}
                onClick={() => matchArray.remove(i)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => matchArray.append({ attr: '', op: 'eq', value: '' })}
        >
          <Plus className="mr-1 h-4 w-4" /> Add condition
        </Button>
      </FormSection>

      <FormSection
        title="Approval steps"
        description={
          <>
            Steps run in order, and each needs enough approvals before the next starts. Use role{' '}
            <code>*</code> to let anyone who may approve sign off.
          </>
        }
      >
        {errors.steps?.message && <p className="text-sm text-destructive">{errors.steps.message}</p>}
        <ApprovalStepsEditor
          steps={form.watch('steps')}
          onChange={(next) =>
            form.setValue('steps', next, { shouldDirty: true, shouldValidate: form.formState.isSubmitted })
          }
          errors={(form.watch('steps') ?? []).map((_, i) => ({
            name: errors.steps?.[i]?.name?.message,
            approverRole: errors.steps?.[i]?.approverRole?.message,
            minApprovals: errors.steps?.[i]?.minApprovals?.message,
          }))}
        />
      </FormSection>

      <Disclosure title="Advanced" summary={`Priority ${form.watch('priority') ?? 0}`}>
        <Field
          id="policy-priority"
          label="Priority"
          hint="When more than one policy fits a request, the one with the higher number decides who signs off. Leave it at 0 unless two of your policies overlap."
          error={errors.priority?.message}
        >
          <Input type="number" className="w-32" {...form.register('priority', { valueAsNumber: true })} />
        </Field>
      </Disclosure>
    </FormPage>
  )
}

export interface ApprovalStepErrors {
  name?: string
  approverRole?: string
  minApprovals?: string
}

/**
 * The ordered sign-off steps, each a name, the role that approves it and how
 * many of them must. Shared by the approval policy form and an amount rule's
 * "Who approves" on the Business plan.
 */
export function ApprovalStepsEditor({
  steps,
  onChange,
  errors = [],
}: {
  steps: ApprovalStep[]
  onChange: (steps: ApprovalStep[]) => void
  errors?: Array<ApprovalStepErrors | undefined>
}) {
  const update = (i: number, patch: Partial<ApprovalStep>) =>
    onChange(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)))
  return (
    <div className="space-y-2">
      {steps.map((step, i) => (
        <div key={i} className="flex flex-col gap-2 sm:flex-row sm:items-start">
          <div className="flex-1">
            <Input
              aria-label={`Step ${i + 1} name`}
              aria-invalid={errors[i]?.name ? true : undefined}
              placeholder="Step name (e.g. finance)"
              value={step.name}
              onChange={(e) => update(i, { name: e.target.value })}
            />
            {errors[i]?.name && <p className="mt-1 text-sm text-destructive">{errors[i]?.name}</p>}
          </div>
          <div className="flex-1">
            <Input
              aria-label={`Step ${i + 1} approver role`}
              aria-invalid={errors[i]?.approverRole ? true : undefined}
              placeholder="approver role (e.g. admin, finance, *)"
              value={step.approverRole}
              onChange={(e) => update(i, { approverRole: e.target.value })}
            />
            {errors[i]?.approverRole && (
              <p className="mt-1 text-sm text-destructive">{errors[i]?.approverRole}</p>
            )}
          </div>
          <div className="flex gap-2 sm:w-40">
            <div className="flex-1">
              <Input
                type="number"
                min={1}
                aria-label={`Step ${i + 1} minimum approvals`}
                aria-invalid={errors[i]?.minApprovals ? true : undefined}
                placeholder="min"
                value={Number.isFinite(step.minApprovals) ? step.minApprovals : ''}
                onChange={(e) => update(i, { minApprovals: e.target.value === '' ? NaN : Number(e.target.value) })}
              />
              {errors[i]?.minApprovals && (
                <p className="mt-1 text-sm text-destructive">{errors[i]?.minApprovals}</p>
              )}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove step ${i + 1}`}
              disabled={steps.length === 1}
              onClick={() => onChange(steps.filter((_, j) => j !== i))}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange([...steps, { name: '', approverRole: '*', minApprovals: 1 }])}
      >
        <Plus className="mr-1 h-4 w-4" /> Add step
      </Button>
    </div>
  )
}

/** The create/edit page, behind the same entitlement as the settings tab. */
export function ApprovalPolicyFormPage() {
  return (
    <EntitlementGate
      feature="approval_policy"
      mode="lock"
      fallback={
        <UpgradePrompt
          feature="approval_policy"
          title="Approval policies"
          description="Have the right people sign off before an agent does something sensitive."
        />
      }
    >
      <ApprovalPolicyEditor />
    </EntitlementGate>
  )
}

function ApprovalPolicyEditor() {
  const { policyId } = useParams<{ policyId?: string }>()
  const queryClient = useQueryClient()
  const { success, error } = useNotifications()

  const policyQuery = useQuery<ApprovalPolicy>({
    queryKey: ['approval-policies', policyId],
    queryFn: () => approvalPoliciesApi.getById(policyId!),
    enabled: !!policyId,
  })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['approval-policies'] })

  const createMutation = useMutation({
    mutationFn: (data: UpsertApprovalPolicy) => approvalPoliciesApi.create(data),
    onSuccess: async () => {
      success('Policy created', 'The approval policy is now active.')
      await invalidate()
    },
    onError: (err: any) => error('Failed to create policy', getApiErrorMessage(err, 'Please try again.')),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<UpsertApprovalPolicy> }) =>
      approvalPoliciesApi.update(id, data),
    onSuccess: async () => {
      success('Policy updated', 'Changes saved.')
      await invalidate()
    },
    onError: (err: any) => error('Failed to update policy', getApiErrorMessage(err, 'Please try again.')),
  })

  const isSaving = createMutation.isPending || updateMutation.isPending

  if (!policyId) {
    return <ApprovalPolicyForm policy={null} isSaving={isSaving} onSubmit={(data) => createMutation.mutateAsync(data)} />
  }
  if (policyQuery.isLoading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <LoadingSpinner size="md" />
      </div>
    )
  }
  if (policyQuery.isError || !policyQuery.data) {
    return (
      <EmptyState
        variant="panel"
        icon={ShieldCheck}
        title="Approval policy not found"
        description="It may have been deleted. Settings > Advanced > Approvals lists the policies that exist."
      />
    )
  }
  const policy = policyQuery.data
  return (
    <ApprovalPolicyForm
      key={policy.id}
      policy={policy}
      isSaving={isSaving}
      onSubmit={(data) => updateMutation.mutateAsync({ id: policy.id, data })}
    />
  )
}
