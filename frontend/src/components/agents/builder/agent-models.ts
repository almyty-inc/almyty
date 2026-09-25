/**
 * The rules for an autonomous agent's models, as the builder applies them.
 *
 * The backend (backend/src/modules/agents/autonomous-models.ts) refuses a
 * save that breaks these with a 400. The page checks the same rules first,
 * so Save is blocked with the fix in words before the request, not after.
 * `__tests__/agent-models-source-guard.test.ts` compares the strategy list
 * and the slot table here against the backend file, so the page cannot
 * offer a strategy the engine does not run, or miss one it does.
 */
import type {
  AgentModelRole,
  AgentModels,
  AutonomousStrategyKey,
  RolePurpose,
} from '@/types/agent-models'

export const AUTONOMOUS_STRATEGY_KEYS: readonly AutonomousStrategyKey[] = [
  'single',
  'cascade',
  'best_of_n',
  'panel',
  'explore_extract_patch',
]

export const ROLE_PURPOSES: readonly RolePurpose[] = [
  'main',
  'drafter',
  'checker',
  'panelist',
  'explorer',
  'summariser',
  'teammate',
]

export const BEST_OF_N_DEFAULT = 3
export const BEST_OF_N_MIN = 2
export const BEST_OF_N_MAX = 5

/** Only these purposes may be filled by another agent; every other is a model. */
export const AGENT_ALLOWED_PURPOSES: readonly RolePurpose[] = ['panelist', 'teammate']

/** Purposes an agent may have more than one of. */
const MULTIPLE: ReadonlySet<RolePurpose> = new Set<RolePurpose>(['panelist', 'explorer', 'teammate'])

/** The slots a strategy needs, as purpose -> minimum count. */
export const STRATEGY_SLOTS: Record<AutonomousStrategyKey, Partial<Record<RolePurpose, number>>> = {
  single: { main: 1 },
  cascade: { main: 1, drafter: 1, checker: 1 },
  best_of_n: { main: 1, checker: 1 },
  panel: { main: 1, panelist: 2 },
  explore_extract_patch: { main: 1, explorer: 1, summariser: 1, checker: 1 },
}

/** Purposes a strategy reads beyond its required slots. */
export const STRATEGY_OPTIONAL: Record<AutonomousStrategyKey, RolePurpose[]> = {
  single: [],
  cascade: [],
  best_of_n: [],
  panel: ['checker'],
  explore_extract_patch: [],
}

export const STRATEGY_LABELS: Record<AutonomousStrategyKey, string> = {
  single: 'Single',
  cascade: 'Cascade',
  best_of_n: 'Best of N',
  panel: 'Panel',
  explore_extract_patch: 'Explore, extract, patch',
}

/** What the engine does, one or two sentences each. Accurate, not aspirational. */
export const STRATEGY_DESCRIPTIONS: Record<AutonomousStrategyKey, string> = {
  single: 'The main role runs every step.',
  cascade:
    'The drafter, a cheaper model, takes each step. When it has a final answer the checker reviews it and tries to refute it; only if the check fails does the main role redo that step.',
  best_of_n:
    'The main role works the task. When it has an answer it writes more candidate answers from the same context, without tools, and the checker picks the best one.',
  panel:
    'The main role works the task, then each panelist answers too (a model over the same conversation, an agent as its own run). The checker, or the main role if there is no checker, writes the answer they agree on.',
  explore_extract_patch:
    'Explorers first gather with the agent\'s tools in parallel, each as its own run on its own model. The summariser compresses what they found into a brief, the main role does the task from the brief, and the checker verifies the answer; a failed check goes back to the main role to revise. Experimental, and not claimed to save money.',
}

export const PURPOSE_LABELS: Record<RolePurpose, string> = {
  main: 'Main',
  drafter: 'Drafter',
  checker: 'Checker',
  panelist: 'Panelist',
  explorer: 'Explorer',
  summariser: 'Summariser',
  teammate: 'Teammate',
}

export const PURPOSE_DESCRIPTIONS: Record<RolePurpose, string> = {
  main: 'Runs the loop: plans, calls tools and writes the answer.',
  drafter: 'A cheaper model that takes each step first; the main role only redoes a step whose check failed.',
  checker: 'Reviews an answer and tries to refute it, or picks the best of several.',
  panelist: 'Answers the same task alongside the main role.',
  explorer: 'Gathers with the agent\'s tools before the main role starts.',
  summariser: 'Compresses what the explorers found into a brief.',
  teammate: 'The main role can hand it work as a tool, in every strategy.',
}

/** "a drafter", "an explorer". */
function withArticle(purpose: RolePurpose): string {
  return /^[aeiou]/.test(purpose) ? `an ${purpose}` : `a ${purpose}`
}

function joinAnd(items: string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** What is missing for a strategy, as purpose -> how many more roles it needs. */
export function missingSlotCounts(models: Pick<AgentModels, 'strategy' | 'roles'>): Array<{ purpose: RolePurpose; missing: number }> {
  const slots = STRATEGY_SLOTS[models.strategy] ?? {}
  const out: Array<{ purpose: RolePurpose; missing: number }> = []
  for (const [purpose, min] of Object.entries(slots) as Array<[RolePurpose, number]>) {
    const have = models.roles.filter((r) => r.purpose === purpose).length
    if (have < min) out.push({ purpose, missing: min - have })
  }
  return out
}

/** "Cascade needs a drafter and a checker", or null when nothing is missing. */
export function missingSlotsSentence(models: Pick<AgentModels, 'strategy' | 'roles'>): string | null {
  const missing = missingSlotCounts(models)
  if (missing.length === 0) return null
  const parts = missing.map(({ purpose, missing: n }) => {
    const min = STRATEGY_SLOTS[models.strategy][purpose] ?? 1
    if (min === 1) return withArticle(purpose)
    const have = min - n
    return have === 0 ? `${min} ${purpose}s` : `${n} more ${purpose}${n === 1 ? '' : 's'}`
  })
  return `${STRATEGY_LABELS[models.strategy]} needs ${joinAnd(parts)}`
}

/** Purposes the chosen strategy reads. Teammates are read by every strategy. */
export function usedPurposes(strategy: AutonomousStrategyKey): Set<RolePurpose> {
  return new Set<RolePurpose>([
    ...(Object.keys(STRATEGY_SLOTS[strategy] ?? {}) as RolePurpose[]),
    ...(STRATEGY_OPTIONAL[strategy] ?? []),
    'teammate',
  ])
}

export function roleIsUsed(strategy: AutonomousStrategyKey, role: Pick<AgentModelRole, 'purpose'>): boolean {
  return usedPurposes(strategy).has(role.purpose)
}

export function canBeAgent(purpose: RolePurpose): boolean {
  return AGENT_ALLOWED_PURPOSES.includes(purpose)
}

export function allowsMultiple(purpose: RolePurpose): boolean {
  return MULTIPLE.has(purpose)
}

/**
 * A key no other role has: the purpose itself for a one-of purpose,
 * `panelist_1`, `panelist_2`... for the rest.
 */
export function nextRoleKey(roles: Pick<AgentModelRole, 'key'>[], purpose: RolePurpose): string {
  const taken = new Set(roles.map((r) => r.key))
  if (!MULTIPLE.has(purpose) && !taken.has(purpose)) return purpose
  for (let i = 1; ; i++) {
    const key = `${purpose}_${i}`
    if (!taken.has(key)) return key
  }
}

/** "Main", "Drafter", "Panelist 2": what a new role of this purpose is called. */
export function defaultRoleName(roles: Pick<AgentModelRole, 'purpose'>[], purpose: RolePurpose): string {
  if (!MULTIPLE.has(purpose)) return PURPOSE_LABELS[purpose]
  const n = roles.filter((r) => r.purpose === purpose).length + 1
  return `${PURPOSE_LABELS[purpose]} ${n}`
}

/** Whether a name is one the page gave the role, so it may follow a purpose change. */
export function isDefaultName(name: string, purpose: RolePurpose): boolean {
  const label = PURPOSE_LABELS[purpose]
  return name === label || new RegExp(`^${label} \\d+$`).test(name)
}

export function newRole(roles: AgentModelRole[], purpose: RolePurpose): AgentModelRole {
  return {
    key: nextRoleKey(roles, purpose),
    name: defaultRoleName(roles, purpose),
    purpose,
    kind: 'model',
  }
}

/** A brand-new autonomous agent: one main role, no model yet, Single. */
export function newAgentModels(): AgentModels {
  return { strategy: 'single', roles: [{ key: 'main', name: 'Main', purpose: 'main', kind: 'model' }] }
}

const MAIN_ROLE_FIELDS = ['providerId', 'model', 'routing', 'temperature', 'maxTokens'] as const

/**
 * What the page edits for an agent: its models, or, for an agent saved
 * before models existed, a Single strategy on its modelConfig.
 */
export function modelsFromAgent(agent: { models?: AgentModels | null; modelConfig?: Record<string, any> | null }): AgentModels {
  if (agent.models && Array.isArray(agent.models.roles)) {
    return {
      strategy: agent.models.strategy,
      roles: agent.models.roles.map((r) => ({ ...r })),
      ...(agent.models.candidates !== undefined && agent.models.candidates !== null
        ? { candidates: agent.models.candidates }
        : {}),
    }
  }
  const main: AgentModelRole = { key: 'main', name: 'Main', purpose: 'main', kind: 'model' }
  const config = agent.modelConfig
  if (config) {
    for (const f of MAIN_ROLE_FIELDS) {
      if (config[f] !== undefined && config[f] !== null && config[f] !== '') (main as any)[f] = config[f]
    }
  }
  return { strategy: 'single', roles: [main] }
}

function hasProvider(role: AgentModelRole): boolean {
  return typeof role.providerId === 'string' && role.providerId.trim() !== ''
}

/**
 * The shape the backend stores: fields that do not apply to a role's kind
 * are dropped, empty ones are left out, and `candidates` only rides along
 * for Best of N.
 */
export function modelsPayload(models: AgentModels): AgentModels {
  const roles = models.roles.map((r) => {
    const out: AgentModelRole = { key: r.key, name: r.name.trim(), purpose: r.purpose, kind: r.kind }
    if (r.kind === 'agent') {
      if (r.agentId) out.agentId = r.agentId
    } else if (r.routing) {
      out.routing = r.routing
    } else {
      if (hasProvider(r)) out.providerId = r.providerId
      if (r.model) out.model = r.model
    }
    if (r.kind === 'model') {
      if (typeof r.temperature === 'number' && !Number.isNaN(r.temperature)) out.temperature = r.temperature
      if (typeof r.maxTokens === 'number' && !Number.isNaN(r.maxTokens)) out.maxTokens = r.maxTokens
    }
    if (r.instructions && r.instructions.trim()) out.instructions = r.instructions
    return out
  })
  const payload: AgentModels = { strategy: models.strategy, roles }
  if (models.strategy === 'best_of_n') payload.candidates = models.candidates ?? BEST_OF_N_DEFAULT
  return payload
}

/**
 * Everything that would stop the save, one sentence each, in the words a
 * person needs to fix it. Empty means the backend will accept the models.
 */
export function modelsProblems(models: AgentModels): string[] {
  const problems: string[] = []
  const label = (r: AgentModelRole) => (r.name.trim() ? r.name.trim() : PURPOSE_LABELS[r.purpose])

  if (!models.roles.some((r) => r.purpose === 'main')) {
    problems.push('Choose a main role: it runs the loop')
  }

  for (const r of models.roles) {
    if (!r.name.trim()) problems.push(`Name the ${r.purpose} role`)
    if (r.kind === 'agent') {
      if (!canBeAgent(r.purpose)) {
        problems.push(`${label(r)} is another agent, and a ${r.purpose} has to be a model: only panelists and teammates can be agents`)
      } else if (!r.agentId) {
        problems.push(`${label(r)}: choose the agent`)
      }
    } else {
      if (!hasProvider(r) && !r.routing) {
        problems.push(`${label(r)}: pick a model, or route it by policy`)
      }
      if (r.temperature !== undefined && r.temperature !== null && (Number.isNaN(r.temperature) || r.temperature < 0 || r.temperature > 2)) {
        problems.push(`${label(r)}: temperature must be a number from 0 to 2`)
      }
      if (r.maxTokens !== undefined && r.maxTokens !== null && (!Number.isInteger(r.maxTokens) || r.maxTokens < 1)) {
        problems.push(`${label(r)}: max tokens must be a positive whole number`)
      }
    }
  }

  for (const purpose of ROLE_PURPOSES) {
    if (MULTIPLE.has(purpose)) continue
    const n = models.roles.filter((r) => r.purpose === purpose).length
    if (n > 1) problems.push(`There are ${n} ${purpose} roles; there can be one`)
  }

  const keys = new Set<string>()
  for (const r of models.roles) {
    if (keys.has(r.key)) problems.push(`Two roles share the key "${r.key}"`)
    keys.add(r.key)
  }

  if (models.strategy === 'best_of_n' && models.candidates !== undefined) {
    const n = models.candidates
    if (!Number.isInteger(n) || n < BEST_OF_N_MIN || n > BEST_OF_N_MAX) {
      problems.push(`Best of N takes ${BEST_OF_N_MIN} to ${BEST_OF_N_MAX} candidates`)
    }
  }

  // A missing main is already said above, in the words that fix it.
  const missing = missingSlotsSentence({
    strategy: models.strategy,
    roles: models.roles.some((r) => r.purpose === 'main') ? models.roles : [...models.roles, { purpose: 'main' } as AgentModelRole],
  })
  if (missing) problems.push(missing)

  return problems
}
