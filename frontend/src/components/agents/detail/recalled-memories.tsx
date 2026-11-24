import type { AgentRunStep } from '@/types'

export type RecalledMemory = { id: string; kind?: string; text?: string; savedAt?: string; savedByRun?: string }

/** The memories a `memory_recall` step read, as the backend records them (agent-memory.keeper.ts recalledMemoryOf). */
export function recalledMemoriesOf(step: Pick<AgentRunStep, 'type' | 'output'>): RecalledMemory[] {
  if (step.type !== 'memory_recall' || !step.output || typeof step.output !== 'object') return []
  const list = (step.output as any).memories
  return Array.isArray(list) ? list.filter((m: any) => m && typeof m.id === 'string') : []
}

/**
 * Which saved memories a run read at its start, and which run saved each:
 * recall provenance, on the step that looked them up.
 */
export function RecalledMemories({ step, index }: { step: Pick<AgentRunStep, 'type' | 'output'>; index: number }) {
  const memories = recalledMemoriesOf(step)
  if (!memories.length) return null
  return (
    <ul className="mt-1 space-y-0.5" data-testid={`run-step-${index}-memories`}>
      {memories.map((m) => (
        <li key={m.id} className="text-xs text-muted-foreground">
          {m.kind ? <span className="text-foreground">[{m.kind}] </span> : null}
          <span className="text-foreground">{m.text || m.id}</span>
          {m.savedByRun ? ` (saved by run ${m.savedByRun.slice(0, 8)}${m.savedAt ? `, ${m.savedAt.slice(0, 10)}` : ''})` : m.savedAt ? ` (saved ${m.savedAt.slice(0, 10)})` : ''}
        </li>
      ))}
    </ul>
  )
}
