/**
 * An amount rule's fields: choose the tool, then the number among its
 * inputs, then the comparison and the amount. Reads back as "Ask before
 * “Create refund” when amount is over 500". A call at or under the amount
 * runs without asking.
 */
import { useQuery } from '@tanstack/react-query'

import { Field } from '@/components/layout/form-page'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toolsApi } from '@/lib/api'
import { describeAmountRule, numericFields } from '@/lib/approval-rules'
import { readableToolName } from '@/lib/tool-names'
import { useOrganizationStore } from '@/store/organization'

export interface AmountRuleValue {
  toolId: string
  argument: string
  op: 'gt' | 'gte'
  amount: string
}

export interface AmountRuleErrors {
  toolId?: string
  argument?: string
  amount?: string
}

/** The organization's tools, as the rule pickers read them. */
export function useRuleTools() {
  const { currentOrganization } = useOrganizationStore()
  const query = useQuery({
    queryKey: ['tools', currentOrganization?.id, 'all'],
    queryFn: () => toolsApi.getAll(currentOrganization?.id),
    enabled: !!currentOrganization?.id,
  })
  const tools: any[] = Array.isArray(query.data) ? query.data : (query.data as any)?.tools || []
  return { tools, isLoading: query.isLoading }
}

/** A tool's name for people, in quotes, for a rule's sentence. */
export function quotedToolName(tool: any, fallback?: string): string {
  return tool ? `“${readableToolName(tool)}”` : fallback || 'this tool'
}

export function AmountRuleFields({
  value,
  onChange,
  errors = {},
}: {
  value: AmountRuleValue
  onChange: (patch: Partial<AmountRuleValue>) => void
  errors?: AmountRuleErrors
}) {
  const { tools, isLoading } = useRuleTools()
  const tool = tools.find((t) => t.id === value.toolId)
  const fields = numericFields(tool)
  const amount = Number(value.amount)
  const complete = !!tool && !!value.argument && value.amount.trim() !== '' && Number.isFinite(amount)

  return (
    <div className="space-y-4">
      <Field id="rule-tool" label="Tool" error={errors.toolId}>
        <Select value={value.toolId} onValueChange={(v) => onChange({ toolId: v, argument: '' })}>
          <SelectTrigger id="rule-tool" aria-invalid={errors.toolId ? true : undefined}>
            <SelectValue placeholder={isLoading ? 'Loading tools…' : 'Choose a tool'}>
              {tool ? readableToolName(tool) : undefined}
            </SelectValue>
          </SelectTrigger>
          <SelectContent className="max-h-80">
            {tools.map((t) => (
              <SelectItem key={t.id} value={t.id} textValue={readableToolName(t)}>
                <span className="block">{readableToolName(t)}</span>
                <span className="block text-xs text-muted-foreground">{t.name}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {tool && fields.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {quotedToolName(tool)} takes no number, so there is no amount to compare. Choose another tool.
        </p>
      )}

      {tool && fields.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field id="rule-argument" label="The number" error={errors.argument}>
            <Select value={value.argument} onValueChange={(v) => onChange({ argument: v })}>
              <SelectTrigger id="rule-argument" aria-invalid={errors.argument ? true : undefined}>
                <SelectValue placeholder="Choose" />
              </SelectTrigger>
              <SelectContent>
                {fields.map((f) => (
                  <SelectItem key={f.path} value={f.path}>
                    {f.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id="rule-op" label="Is">
            <Select value={value.op} onValueChange={(v) => onChange({ op: v as 'gt' | 'gte' })}>
              <SelectTrigger id="rule-op">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="gt">over</SelectItem>
                <SelectItem value="gte">at or over</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field id="rule-amount" label="Amount" hint="Just the number; the tool's own currency." error={errors.amount}>
            <Input
              id="rule-amount"
              inputMode="decimal"
              placeholder="500"
              value={value.amount}
              aria-invalid={errors.amount ? true : undefined}
              onChange={(e) => onChange({ amount: e.target.value })}
            />
          </Field>
        </div>
      )}

      {complete && (
        <p className="rounded-md border bg-muted/40 p-3 text-sm" data-testid="amount-rule-summary">
          <span className="font-medium">
            {describeAmountRule({ toolName: quotedToolName(tool), argument: value.argument, op: value.op, amount })}
          </span>
          <span className="block text-muted-foreground">
            A call {value.op === 'gte' ? 'under' : 'at or under'} the amount runs without asking.
          </span>
        </p>
      )}
    </div>
  )
}
