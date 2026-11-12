import type { Agent } from '@/types'

/**
 * The two numbers an agent's runs are summed up by, everywhere they are
 * shown (the agent header, analytics):
 *
 * - "Completed": the share of runs that finished. It says nothing about
 *   whether an answer was right.
 * - "Checks passed": for an agent whose answers a checker reviews, the
 *   share of checked runs whose check passed. A run no checker could give
 *   a verdict on was not checked and is not counted.
 *
 * They used to be one "Success rate" that counted finished runs and
 * ignored the checks, so an agent whose every answer failed its check
 * still read 100%.
 */

type RunCounts = Pick<Agent, 'totalExecutions' | 'successfulExecutions' | 'checkedExecutions' | 'passedCheckExecutions' | 'agentConfig'>

export const COMPLETED_LABEL = 'Completed'
export const CHECKS_PASSED_LABEL = 'Checks passed'

/** Whole percent of `part` in `whole`, or null when there is nothing to divide. */
function percent(part: number | undefined | null, whole: number | undefined | null): number | null {
  if (!whole || whole <= 0) return null
  return Math.round(((part ?? 0) / whole) * 100)
}

/** The share of runs that finished, or null before the first run. */
export function completedPercent(agent: RunCounts): number | null {
  return percent(agent.successfulExecutions, agent.totalExecutions)
}

/** Whether a checker reviews this agent's final answers. */
export function hasAnswerCheck(agent: Pick<Agent, 'agentConfig'>): boolean {
  const verify = agent.agentConfig?.verify
  if (!verify?.enabled) return false
  return (verify.triggers ?? ['on_final_output']).includes('on_final_output')
}

/**
 * "Checks passed" for an agent with a check: passed of checked, and the
 * percent (null until a run was checked). Null for an agent without a
 * check, which shows no such number at all.
 */
export function checksPassed(agent: RunCounts): { passed: number; checked: number; percent: number | null } | null {
  if (!hasAnswerCheck(agent)) return null
  const checked = agent.checkedExecutions ?? 0
  const passed = agent.passedCheckExecutions ?? 0
  return { passed, checked, percent: percent(passed, checked) }
}
