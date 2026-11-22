import type { Agent, AgentRunStats } from '@/types'

/**
 * The numbers an agent's runs are summed up by, everywhere they are shown
 * (the agent header, the agents list, analytics):
 *
 * - "Total runs", "Avg run time", "Total cost": over the agent's finished
 *   runs that still exist. The server works them out from the runs
 *   (`agent.runStats`), so a deleted, erased or swept run drops out; the
 *   lifetime counters on the agent row kept counting it.
 * - "Completed": the share of runs that finished. It says nothing about
 *   whether an answer was right.
 * - "No errors found": for an agent whose answers a checker reviews, the
 *   share of checked runs whose check found no mismatch with the tool
 *   results. That is not the share of correct answers: a detail the tool
 *   results hold nothing to compare with passes. A run no checker could
 *   give a verdict on was not checked and is not counted.
 */

type RunCounts = Pick<Agent, 'runStats' | 'agentConfig'>

export const COMPLETED_LABEL = 'Completed'
export const CHECKS_PASSED_LABEL = 'No errors found'
/** The hint beside the number: what a run counted there means. */
export const CHECKS_PASSED_HINT = "Checked runs whose check found no mismatch with the tool results. It can't confirm everything an answer says."

const NO_RUNS: AgentRunStats = { runs: 0, completed: 0, checked: 0, checksPassed: 0, averageRunTimeMs: 0, totalCost: 0 }

/** The agent's numbers from its existing runs; zeros when the server sent none. */
export function runNumbers(agent: Pick<Agent, 'runStats'>): AgentRunStats {
  return agent.runStats ?? NO_RUNS
}

/** Whole percent of `part` in `whole`, or null when there is nothing to divide. */
function percent(part: number | undefined | null, whole: number | undefined | null): number | null {
  if (!whole || whole <= 0) return null
  return Math.round(((part ?? 0) / whole) * 100)
}

/** The share of runs that finished, or null when there are no runs. */
export function completedPercent(agent: Pick<Agent, 'runStats'>): number | null {
  const { completed, runs } = runNumbers(agent)
  return percent(completed, runs)
}

/** Whether a checker reviews this agent's final answers. */
export function hasAnswerCheck(agent: Pick<Agent, 'agentConfig'>): boolean {
  const verify = agent.agentConfig?.verify
  if (!verify?.enabled) return false
  return (verify.triggers ?? ['on_final_output']).includes('on_final_output')
}

/**
 * "No errors found" for an agent with a check: passed of checked, and the
 * percent (null until a run was checked). Null for an agent without a
 * check, which shows no such number at all.
 */
export function checksPassed(agent: RunCounts): { passed: number; checked: number; percent: number | null } | null {
  if (!hasAnswerCheck(agent)) return null
  const { checked, checksPassed: passed } = runNumbers(agent)
  return { passed, checked, percent: percent(passed, checked) }
}
