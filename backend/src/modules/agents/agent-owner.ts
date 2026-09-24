const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The user a run nobody asked for (a heartbeat, a schedule tick) runs as:
 * the agent's recorded owner as the row stands now, or nobody.
 *
 * `createdBy` is a varchar that nothing in the schema holds to a user id,
 * while a run's user lands in `conversations."userId"`, a uuid referencing
 * users -- so anything that is not a user id is nobody, never a string
 * passed through. Read at run time rather than snapshotted: a departing
 * member's private agents are handed to another member, and a snapshot
 * kept running them as someone the private-visibility checks refuse.
 */
export function agentOwnerUserId(agent: { createdBy?: string | null }): string | null {
  const owner = agent.createdBy;
  return typeof owner === 'string' && UUID_RE.test(owner) ? owner : null;
}
