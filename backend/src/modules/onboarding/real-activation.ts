import type { Agent } from '../../entities/agent.entity';

/**
 * What "real" means for activation: something the org set up itself, not a
 * scratch copy and not a sample. One definition, read by the guide's
 * `activatedRealAt` (OnboardingService) and by the `first_run_succeeded`
 * analytics event (ProductAnalyticsService), so the dashboard's "you are
 * activated" and the funnel's never disagree.
 *
 * - Samples carry `metadata.sampleWorkspace` (an older build seeded a
 *   sample workspace with it; nothing real ever sets it).
 * - `isTemporary` agents are the copies the runtime spawns for a sub-agent
 *   step, not something a person made.
 */
export const SAMPLE_WORKSPACE_FLAG = 'sampleWorkspace';

export function isOwnAgent(agent: Pick<Agent, 'isTemporary' | 'metadata'> | null | undefined): boolean {
  if (!agent || agent.isTemporary) return false;
  const metadata = agent.metadata as Record<string, unknown> | null | undefined;
  return metadata?.[SAMPLE_WORKSPACE_FLAG] == null;
}
