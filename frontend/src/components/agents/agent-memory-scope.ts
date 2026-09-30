import type { MemoryScopeType } from '@/lib/api'
import type { AgentMemoryConfig } from '@/types/agent-models'

/**
 * The memory an agent's Memory tab shows and adds to: the one its runs
 * read and write (backend: memoryScopeFor).
 *
 *  - "This agent's own": the agent's scope, `<org>:agent:<agentId>`.
 *  - "Each person has their own": the viewer's own (the server maps the
 *    `user` scope to the signed-in member).
 *  - "Shared by all agents": the organization's workspace memory.
 */
export function agentMemoryScope(
  memoryConfig: AgentMemoryConfig | null | undefined,
  organizationId: string,
  agentId: string,
): { scope_type: MemoryScopeType; scope_id: string } {
  switch (memoryConfig?.whose) {
    case 'agent':
      return { scope_type: 'agent', scope_id: `${organizationId}:agent:${agentId}` }
    case 'person':
      return { scope_type: 'user', scope_id: organizationId }
    default:
      return { scope_type: 'workspace', scope_id: organizationId }
  }
}
