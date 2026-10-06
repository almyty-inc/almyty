/**
 * Approval policies' amount rules, as the policy page and list read
 * them: "Ask before issue_refund when amount is over 500". Mirrors
 * describeToolAmountRule in backend/src/modules/tools/tool-approval-gate.service.ts.
 */
import type { ApprovalToolAmountTrigger } from '@/lib/api'
import { toolParameters } from '@/components/agents/tool-step-inputs'

function plainAmount(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

/** The rule in plain words. */
export function describeAmountRule(
  trigger: Pick<ApprovalToolAmountTrigger, 'argument' | 'op' | 'amount'> & { toolName?: string },
): string {
  const tool = trigger.toolName || 'this tool'
  const limit =
    trigger.op === 'gte' ? `is ${plainAmount(trigger.amount)} or more` : `is over ${plainAmount(trigger.amount)}`
  return `Ask before ${tool} when ${trigger.argument} ${limit}`
}

/** One number a tool takes, as the rule can name it. */
export interface NumericField {
  /** Dot path into the tool's input: `amount`, `refund.total`. */
  path: string
  /** How it reads in the list: its title or description when the schema has one. */
  label: string
}

function isNumeric(schema: any): boolean {
  const type = schema?.type
  if (Array.isArray(type)) return type.includes('number') || type.includes('integer')
  return type === 'number' || type === 'integer'
}

/**
 * The numbers among a tool's inputs, nested objects included (three
 * levels down), in the order its schema lists them.
 */
export function numericFields(tool: unknown): NumericField[] {
  const params = toolParameters(tool)
  if (!params) return []
  const out: NumericField[] = []
  const walk = (properties: Record<string, any>, prefix: string, depth: number) => {
    for (const [key, schema] of Object.entries(properties)) {
      const path = prefix ? `${prefix}.${key}` : key
      if (isNumeric(schema)) {
        const words = schema?.title || schema?.description
        out.push({ path, label: words ? `${path} (${String(words).slice(0, 60)})` : path })
      } else if (depth < 3 && schema && typeof schema === 'object' && schema.properties && typeof schema.properties === 'object') {
        walk(schema.properties, path, depth + 1)
      }
    }
  }
  walk(params.properties, '', 1)
  return out
}
