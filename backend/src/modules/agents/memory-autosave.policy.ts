import type { AgentRun } from '../../entities/agent-run.entity';

/**
 * Whether a run may write memory at all -- by auto-save (facts, the
 * conversation) or by the `store_memory` tool, whichever scope it goes to.
 *
 * Memory is read back into later runs: shared memory for everyone, a
 * visitor's own memory for that visitor. A run started by a member of the
 * public must therefore not write it unless the product said visitors'
 * memory may be kept; otherwise one visitor's question would surface in
 * another's answer, and the tenant would be storing personal data it
 * never asked for.
 *
 * Not a visitor's run: a product may opt its visitors in (app privacy
 * setting, carried on the run when the surface starts it), and the
 * default stays out. The tool used to skip this, so a visitor could ask
 * the agent to remember something and plant it in every later run's
 * recall.
 *
 * A visitor is either an end user with a row of their own (the hosted
 * chat) or anyone on one of an app's other places -- a widget thread, a
 * messaging-channel sender, an A2A caller -- which have no end-user row
 * and are marked `appVisitor` on the run instead. Before that mark, a
 * widget or Slack run had no endUserId, read as an operator's own run,
 * and fed shared memory whatever the app's privacy setting said.
 */
export function runMayWriteSharedMemory(
  run: Pick<AgentRun, 'endUserId'> & { metadata?: Record<string, any> | null },
): boolean {
  if (run.endUserId || run.metadata?.appVisitor === true) return run.metadata?.visitorMemory === true;
  return true;
}
