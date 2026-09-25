import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export interface AgentOption {
  id: string
  name: string
}

/**
 * Pick one agent. The one select every screen that asks "which agent?"
 * uses: a new app, the agents of an app, a workflow step that calls
 * another agent. The caller holds the list, so it can say what to do when
 * there is none (usually: link to making one).
 */
export function AgentSelect({
  id,
  agents,
  value,
  onChange,
  placeholder = 'Pick an agent',
  ariaLabel,
  emptyText = 'No agents yet.',
  className,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedBy,
}: {
  id?: string
  agents: AgentOption[]
  value: string | null | undefined
  onChange: (agent: AgentOption) => void
  placeholder?: string
  /** When there is no visible label pointing at `id`. */
  ariaLabel?: string
  /** Shown inside the open list when there is nothing to pick. */
  emptyText?: string
  className?: string
  /** Set by the shared Field, like on any other control. */
  'aria-invalid'?: boolean
  'aria-describedby'?: string
}) {
  return (
    <Select
      value={value ?? ''}
      onValueChange={(next) => {
        const agent = agents.find((a) => a.id === next)
        if (agent) onChange(agent)
      }}
    >
      <SelectTrigger id={id} aria-label={ariaLabel} aria-invalid={ariaInvalid || undefined} aria-describedby={ariaDescribedBy} className={className}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {agents.length === 0 && <div className="px-3 py-2 text-sm text-muted-foreground">{emptyText}</div>}
        {agents.map((agent) => (
          <SelectItem key={agent.id} value={agent.id}>
            {agent.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
