/**
 * Private (owner-only) tools in an agent.
 *
 * The server refuses an agent that uses a private tool unless the agent is
 * private to the same owner (`assertAttachable`, 400 "These tools are
 * private to their owner ..."): an org-wide agent would hand the tool to
 * everyone who can run it. A runner's tools are private to whoever
 * registered the runner, so this is what an agent built on a runner meets
 * first. The builder uses these helpers to start such an agent as private,
 * and to answer a refused save with the fix next to Save.
 */
import type { Tool } from '@/types'

interface NodeLike {
  type?: string
  data?: Record<string, unknown>
}

/** The tools an agent's save sends, in the mode it is saved in (what the server checks). */
export function referencedToolIds(
  mode: 'workflow' | 'autonomous',
  toolIds: string[],
  nodes: NodeLike[],
): string[] {
  if (mode === 'autonomous') return toolIds
  const ids = new Set<string>()
  for (const node of nodes) {
    const data = node.data ?? {}
    if (node.type === 'tool_call' && typeof data.toolId === 'string' && data.toolId) ids.add(data.toolId)
    if (node.type === 'llm_call' && Array.isArray(data.toolIds)) {
      for (const id of data.toolIds) if (typeof id === 'string' && id) ids.add(id)
    }
  }
  return [...ids]
}

/** The private tools among `ids`. */
export function privateToolsAmong<T extends Pick<Tool, 'id' | 'name' | 'visibility'>>(ids: string[], tools: T[]): T[] {
  const wanted = new Set(ids)
  return tools.filter((tool) => wanted.has(tool.id) && tool.visibility === 'private')
}

/** Is this save refusal the "private tools need a private agent" one? */
export function isPrivateReferenceRefusal(message: string | null | undefined): boolean {
  return !!message && /are private to their owner/i.test(message)
}
