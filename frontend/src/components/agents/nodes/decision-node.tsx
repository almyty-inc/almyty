import React from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Scale } from 'lucide-react'

/**
 * A typed question over a declared option set.
 *
 * This is the canvas half of the `decide` contract (see
 * backend/src/modules/model-catalog/decide/decide-contract.ts): the node
 * asks one question, gets a distribution back and routes on the argmax.
 * So it has one edge per option rather than one edge out, and an
 * `abstain` edge that every choice question carries by construction --
 * an answer that scores below its option's threshold leaves down that
 * edge instead of down the option it nominally picked. Without it a
 * low-confidence guess is indistinguishable from a real answer to
 * everything downstream.
 */

interface DecisionOption {
  id?: string
  description?: string
  abstain?: boolean
}

interface DecisionQuestion {
  id?: string
  type?: string
  prompt?: string
  options?: DecisionOption[]
  optionsOrderPolicy?: string
}

export function DecisionNode({ data, selected }: NodeProps) {
  const question = (data.question as DecisionQuestion | undefined) || {}
  const options = Array.isArray(question.options) ? question.options : []
  const thresholds = (data.thresholds as Record<string, number> | undefined) || {}

  // The abstain option is a declared option, but it is also the node's
  // fallback edge, so it is drawn once at the bottom under its own
  // `abstain` handle rather than twice.
  const choices = options.filter((option) => option?.abstain !== true && option?.id)
  const abstain = options.find((option) => option?.abstain === true)
  // The executor refuses a boolean question outright: it declares no
  // options, so it has no abstain edge and the threshold protects nothing.
  const isBoolean = question.type === 'boolean'
  const outcomes = choices

  return (
    <div className={`rounded-xl border-2 bg-card shadow-sm w-[220px] hover:shadow-md transition-shadow ${selected ? 'border-primary ring-2 ring-primary' : 'border-border'}`}>
      <Handle type="target" position={Position.Left} className="!w-3 !h-3 !bg-cyan-500 !border-cyan-600" />
      <div className="px-3 py-2 bg-gradient-to-r from-cyan-50 to-cyan-100 dark:from-cyan-950 dark:to-cyan-900 rounded-t-[10px] border-b flex items-center gap-2">
        <Scale className="h-3.5 w-3.5 text-cyan-700 dark:text-cyan-300" />
        <span className="text-xs font-semibold text-cyan-700 dark:text-cyan-300">Decision</span>
      </div>
      <div className="p-3">
        <div className="text-sm font-medium truncate">
          {question.prompt ? String(question.prompt) : 'No question'}
        </div>
        <div className="text-xs text-muted-foreground truncate mt-0.5">
          {(question.type as string) || 'choice'}
          {` · ${outcomes.length} option${outcomes.length === 1 ? '' : 's'}`}
        </div>
        {isBoolean && (
          <div className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
            Boolean is refused; ask it as a choice
          </div>
        )}

        <div className="mt-2 space-y-1">
          {outcomes.length === 0 && (
            <div className="text-xs text-muted-foreground">No options</div>
          )}
          {outcomes.map((option) => {
            const id = String(option.id)
            const threshold = thresholds[id]
            return (
              <div key={id} className="relative flex items-center gap-1.5 pr-2">
                <div className="w-2 h-2 rounded-full bg-cyan-500 shrink-0" />
                <span className="text-xs truncate">{id}</span>
                {typeof threshold === 'number' && (
                  <span className="text-[10px] text-muted-foreground ml-auto shrink-0 tabular-nums">
                    &ge; {threshold}
                  </span>
                )}
                <Handle
                  type="source"
                  position={Position.Right}
                  id={id}
                  className="!w-3 !h-3 !bg-cyan-500 !border-cyan-600"
                />
              </div>
            )
          })}

          {/* Always drawn. A choice question without an escape hatch answers
              "the state does not say" with its best-scoring wrong option. */}
          <div className="relative flex items-center gap-1.5 pr-2">
            <div className="w-2 h-2 rounded-full bg-zinc-400 shrink-0" />
            <span className="text-xs text-muted-foreground truncate">
              {abstain?.id ? String(abstain.id) : 'abstain'}
            </span>
            <Handle
              type="source"
              position={Position.Right}
              id="abstain"
              className="!w-3 !h-3 !bg-zinc-400 !border-zinc-500"
            />
          </div>
        </div>
      </div>
    </div>
  )
}
