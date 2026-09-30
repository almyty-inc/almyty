/**
 * The words the memory pages use for the store's internal names.
 *
 * The API speaks in tiers (`short`, `project`, `long`, `shared`) and
 * backend ids (`almyty-native`, `mem0`); a person reads how long a memory
 * is kept and which service keeps it.
 */
import type { MemoryTier } from '@/lib/api'

export const MEMORY_TIER_LABELS: Record<MemoryTier, string> = {
  short: 'Short-term',
  project: 'This project',
  long: 'Long-term',
  shared: 'Shared by all agents',
}

/** One line on what each length means, for the add form. */
export const MEMORY_TIER_HINTS: Record<MemoryTier, string> = {
  short: 'Notes from recent work. Tidied into long-term facts every hour.',
  project: 'Kept while the project it belongs to is going.',
  long: 'Lasting facts and preferences.',
  shared: 'Kept for good and seen by every agent in the organization.',
}

const BACKEND_NAMES: Record<string, string> = {
  'almyty-native': 'almyty (built in)',
  mem0: 'Mem0',
  supermemory: 'Supermemory',
  zep: 'Zep',
  'vertex-memory-bank': 'Vertex AI Memory Bank',
  'anthropic-memory-tool': 'Claude memory tool',
}

/** A storage service's name as people know it; an unknown id is shown as it is. */
export function memoryBackendName(id: string): string {
  return BACKEND_NAMES[id] ?? id
}
