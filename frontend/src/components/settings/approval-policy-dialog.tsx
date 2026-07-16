/**
 * ApprovalPolicyDialog — create / edit modal for an approval policy.
 *
 * Owns its own react-hook-form + zod validation and mirrors the real backend
 * DTO (`UpsertPolicyDto` -> ApprovalPolicy entity): name, description, optional
 * team scoping, priority, enabled, an ANDed list of match conditions
 * ({ attr, op, value }) that decide WHEN the policy fires, and an ordered list
 * of sequential quorum steps ({ name, approverRole, minApprovals }) that decide
 * WHO must sign off. Parent supplies open state + submit handler (mutation).
 */
import { useForm, useFieldArray } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import * as z from 'zod'
import { Plus, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { ApprovalPolicy, UpsertApprovalPolicy } from '@/lib/api'

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

export type ApprovalPolicyForm = z.infer<typeof approvalPolicySchema>

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

export interface ApprovalPolicyDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The policy being edited, or null when creating a new one. */
  policy: ApprovalPolicy | null
  isSaving: boolean
  onSubmit: (data: UpsertApprovalPolicy) => void
}

export function ApprovalPolicyDialog({
  open,
  onOpenChange,
  policy,
  isSaving,
  onSubmit,
}: ApprovalPolicyDialogProps) {
  const form = useForm<ApprovalPolicyForm>({
    resolver: zodResolver(approvalPolicySchema),
    values: {
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

  const matchArray = useFieldArray({ control: form.control, name: 'match' })
  const stepsArray = useFieldArray({ control: form.control, name: 'steps' })

  const submit = (data: ApprovalPolicyForm) => {
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
    onSubmit(payload)
  }

  const errors = form.formState.errors

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{policy ? 'Edit Approval Policy' : 'New Approval Policy'}</DialogTitle>
          <DialogDescription>
            Match conditions decide when an approval is required; steps decide who
            must sign off, in order. A request must clear every step before it is
            approved.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(submit)} className="space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <Label htmlFor="policy-name">Name</Label>
              <Input
                id="policy-name"
                placeholder="Refunds over $1,000"
                {...form.register('name')}
              />
              {errors.name && (
                <p className="text-sm text-red-500 mt-1">{errors.name.message}</p>
              )}
            </div>

            <div className="col-span-2">
              <Label htmlFor="policy-description">Description</Label>
              <Textarea
                id="policy-description"
                placeholder="Why this policy exists (optional)"
                {...form.register('description')}
              />
            </div>

            <div>
              <Label htmlFor="policy-priority">Priority</Label>
              <Input
                id="policy-priority"
                type="number"
                {...form.register('priority', { valueAsNumber: true })}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Highest priority wins when several policies match.
              </p>
              {errors.priority && (
                <p className="text-sm text-red-500 mt-1">{errors.priority.message}</p>
              )}
            </div>

            <div>
              <Label htmlFor="policy-team">Team ID (optional)</Label>
              <Input
                id="policy-team"
                placeholder="Scope to a team"
                {...form.register('teamId')}
              />
            </div>

            <div className="col-span-2 flex items-center justify-between rounded-md border p-3">
              <div>
                <Label>Enabled</Label>
                <p className="text-xs text-muted-foreground">
                  Only enabled policies are evaluated against requests.
                </p>
              </div>
              <Switch
                checked={form.watch('enabled')}
                onCheckedChange={(v) => form.setValue('enabled', v)}
              />
            </div>
          </div>

          {/* Match conditions */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <Label>Match conditions</Label>
                <p className="text-xs text-muted-foreground">
                  All conditions must hold (AND). Leave empty to match every request.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => matchArray.append({ attr: '', op: 'eq', value: '' })}
              >
                <Plus className="h-4 w-4 mr-1" /> Add condition
              </Button>
            </div>

            {matchArray.fields.length === 0 && (
              <p className="text-sm text-muted-foreground italic">
                No conditions — this policy applies to every request.
              </p>
            )}

            {matchArray.fields.map((field, i) => (
              <div key={field.id} className="flex gap-2 items-start">
                <div className="flex-1">
                  <Input
                    aria-label={`Condition ${i + 1} attribute`}
                    placeholder="attr (e.g. amount, toolName)"
                    {...form.register(`match.${i}.attr` as const)}
                  />
                  {errors.match?.[i]?.attr && (
                    <p className="text-sm text-red-500 mt-1">
                      {errors.match[i]?.attr?.message}
                    </p>
                  )}
                </div>
                <Select
                  value={form.watch(`match.${i}.op`)}
                  onValueChange={(v) => form.setValue(`match.${i}.op`, v as any)}
                >
                  <SelectTrigger className="w-40" aria-label={`Condition ${i + 1} operator`}>
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
                <div className="flex-1">
                  <Input
                    aria-label={`Condition ${i + 1} value`}
                    placeholder="value (comma-separated for in/nin)"
                    {...form.register(`match.${i}.value` as const)}
                  />
                </div>
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
            ))}
          </div>

          {/* Approval steps */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <Label>Approval steps</Label>
                <p className="text-xs text-muted-foreground">
                  Sequential. Each step needs its quorum before the next begins. Use
                  role <code>*</code> for any authorized approver.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  stepsArray.append({ name: '', approverRole: '*', minApprovals: 1 })
                }
              >
                <Plus className="h-4 w-4 mr-1" /> Add step
              </Button>
            </div>

            {errors.steps?.message && (
              <p className="text-sm text-red-500">{errors.steps.message}</p>
            )}

            {stepsArray.fields.map((field, i) => (
              <div key={field.id} className="flex gap-2 items-start">
                <div className="flex-1">
                  <Input
                    aria-label={`Step ${i + 1} name`}
                    placeholder="Step name (e.g. finance)"
                    {...form.register(`steps.${i}.name` as const)}
                  />
                  {errors.steps?.[i]?.name && (
                    <p className="text-sm text-red-500 mt-1">
                      {errors.steps[i]?.name?.message}
                    </p>
                  )}
                </div>
                <div className="flex-1">
                  <Input
                    aria-label={`Step ${i + 1} approver role`}
                    placeholder="approver role (e.g. admin, *)"
                    {...form.register(`steps.${i}.approverRole` as const)}
                  />
                  {errors.steps?.[i]?.approverRole && (
                    <p className="text-sm text-red-500 mt-1">
                      {errors.steps[i]?.approverRole?.message}
                    </p>
                  )}
                </div>
                <div className="w-28">
                  <Input
                    type="number"
                    min={1}
                    aria-label={`Step ${i + 1} minimum approvals`}
                    placeholder="min"
                    {...form.register(`steps.${i}.minApprovals` as const, { valueAsNumber: true })}
                  />
                  {errors.steps?.[i]?.minApprovals && (
                    <p className="text-sm text-red-500 mt-1">
                      {errors.steps[i]?.minApprovals?.message}
                    </p>
                  )}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove step ${i + 1}`}
                  disabled={stepsArray.fields.length === 1}
                  onClick={() => stepsArray.remove(i)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSaving}>
              {isSaving ? 'Saving...' : policy ? 'Save changes' : 'Create policy'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
