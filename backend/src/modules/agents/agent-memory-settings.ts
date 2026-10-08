import type { Agent } from '../../entities/agent.entity';
import type { AgentRun } from '../../entities/agent-run.entity';
import type { ScopeRef } from '../memory/canonical/canonical.types';
import { agentScopeId, userScopeId, visitorScopeId } from '../memory/canonical/canonical-memory.helpers';
import { NATIVE_MEMORY_ACCOUNT, memoryAccountName } from '../memory/canonical/memory-accounts.service';
import type { MemoryAccount } from '../memory/canonical/memory-accounts.service';

export { NATIVE_MEMORY_ACCOUNT };

/**
 * An autonomous agent's Memory section, as the server reads it.
 *
 *  - `account`: where its memories are kept: almyty's own store, or an
 *    outside memory service the organization set up on the Memory page.
 *  - `whose`: `person` (the member, or visitor, the run is for), `agent`
 *    (this agent alone) or `shared` (the organization's memory every agent
 *    sees).
 *  - `save`: `facts` (after each run the agent's model picks out what is
 *    worth keeping), `conversations` (each exchange, as said) or `asked`
 *    (only when the person asks it to remember something).
 *  - `neverSave`: rules, one per line; every save is screened against them
 *    by the agent's model first, and what they cover is dropped.
 *  - `retentionDays`: how long a memory is kept; null until deleted.
 *
 * See docs-site/content/agents/memory.mdx.
 */
export type MemoryWhose = 'person' | 'agent' | 'shared';
export type MemorySave = 'facts' | 'conversations' | 'asked';

export const MEMORY_WHOSE: readonly MemoryWhose[] = ['person', 'agent', 'shared'];
export const MEMORY_SAVE: readonly MemorySave[] = ['facts', 'conversations', 'asked'];
export const RETENTION_DAYS_MAX = 3650;
export const NEVER_SAVE_MAX_CHARS = 2000;

export interface AgentMemoryConfig {
  enabled?: boolean;
  /** Before `save` existed: auto-save on means `facts`. */
  autoSave?: boolean;
  scopes?: string[];
  account?: string;
  whose?: MemoryWhose;
  save?: MemorySave;
  neverSave?: string;
  retentionDays?: number | null;
  /**
   * An account of the agent's own for `account` (a connection added from the
   * agent's page), instead of the organization's for that service. Who can
   * use it follows the connection's own scope.
   */
  credentialId?: string | null;
}

export interface MemorySettings {
  enabled: boolean;
  account: string;
  whose: MemoryWhose;
  save: MemorySave;
  neverSave: string[];
  retentionDays: number | null;
  /** The agent's own account (a connection) for `account`; null uses the organization's. */
  credentialId: string | null;
}

/** The settings with every default filled in. */
export function memorySettings(cfg: AgentMemoryConfig | null | undefined): MemorySettings {
  const c = cfg ?? {};
  return {
    enabled: c.enabled === true,
    account: typeof c.account === 'string' && c.account ? c.account : NATIVE_MEMORY_ACCOUNT,
    whose: MEMORY_WHOSE.includes(c.whose as MemoryWhose) ? (c.whose as MemoryWhose) : 'shared',
    save: MEMORY_SAVE.includes(c.save as MemorySave) ? (c.save as MemorySave) : c.autoSave ? 'facts' : 'asked',
    neverSave: typeof c.neverSave === 'string'
      ? c.neverSave.split('\n').map((l) => l.trim()).filter(Boolean)
      : [],
    retentionDays: typeof c.retentionDays === 'number' && c.retentionDays > 0 ? c.retentionDays : null,
    credentialId: typeof c.credentialId === 'string' && c.credentialId ? c.credentialId : null,
  };
}

/** The ttl a saved memory carries, in seconds; null keeps it until deleted. */
export function retentionSeconds(s: Pick<MemorySettings, 'retentionDays'>): number | null {
  return s.retentionDays ? s.retentionDays * 86_400 : null;
}

/**
 * Whose memory `run` reads and writes, or null when there is none: memory
 * off, or "per person" on a run that is for nobody (a heartbeat, an A2A
 * caller). A visitor's own memory is a scope of its own, apart from every
 * member's; whether the run may write it is runMayWriteSharedMemory's call.
 * An agent acting as itself (agent_identity) is the person: "per person"
 * keeps its memories in the agent's own scope, never its owner's.
 */
export function memoryScopeFor(
  agent: Pick<Agent, 'id' | 'memoryConfig'>,
  run: Pick<AgentRun, 'organizationId' | 'userId' | 'endUserId'> & { principal?: { kind?: string } | null },
): ScopeRef | null {
  const s = memorySettings(agent.memoryConfig as AgentMemoryConfig);
  if (!s.enabled) return null;
  switch (s.whose) {
    case 'shared':
      return { scope_type: 'workspace', scope_id: run.organizationId };
    case 'agent':
      return { scope_type: 'agent', scope_id: agentScopeId(run.organizationId, agent.id) };
    case 'person':
      if (run.principal?.kind === 'agent') return { scope_type: 'agent', scope_id: agentScopeId(run.organizationId, agent.id) };
      if (run.userId) return { scope_type: 'user', scope_id: userScopeId(run.organizationId, run.userId) };
      if (run.endUserId) return { scope_type: 'user', scope_id: visitorScopeId(run.organizationId, run.endUserId) };
      return null;
  }
}

/**
 * Everything wrong with a memory configuration, one sentence each. With
 * `accounts` (the organization's, MemoryAccountsService.accounts) the
 * account is checked too.
 */
export function memoryConfigProblems(cfg: unknown, accounts?: Array<Pick<MemoryAccount, 'id' | 'name' | 'canExpire'>>): string[] {
  if (cfg === null || cfg === undefined) return [];
  if (typeof cfg !== 'object' || Array.isArray(cfg)) return ['Memory settings must be an object'];
  const c = cfg as Record<string, unknown>;
  const problems: string[] = [];
  if (c.whose !== undefined && !MEMORY_WHOSE.includes(c.whose as MemoryWhose)) {
    problems.push(`Whose memory must be one of: ${MEMORY_WHOSE.join(', ')}`);
  }
  if (c.save !== undefined && !MEMORY_SAVE.includes(c.save as MemorySave)) {
    problems.push(`What gets saved must be one of: ${MEMORY_SAVE.join(', ')}`);
  }
  if (c.retentionDays !== undefined && c.retentionDays !== null) {
    const n = c.retentionDays as number;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > RETENTION_DAYS_MAX) {
      problems.push(`Keep memories for 1 to ${RETENTION_DAYS_MAX} days, or until deleted`);
    }
  }
  if (c.neverSave !== undefined && c.neverSave !== null) {
    if (typeof c.neverSave !== 'string') problems.push('The never-save rules must be text, one rule per line');
    else if (c.neverSave.length > NEVER_SAVE_MAX_CHARS) problems.push(`Keep the never-save rules under ${NEVER_SAVE_MAX_CHARS} characters`);
  }
  if (c.credentialId !== undefined && c.credentialId !== null) {
    if (typeof c.credentialId !== 'string' || !c.credentialId) problems.push("The agent's own memory account must be a connection id");
    else if (!c.account || c.account === NATIVE_MEMORY_ACCOUNT) problems.push("almyty's own memory needs no account: choose the service the connection is for");
  }
  if (c.account !== undefined && c.account !== null && typeof c.account !== 'string') {
    problems.push('The memory account must be an account id');
  } else if (accounts && typeof c.account === 'string' && c.account) {
    const account = accounts.find((a) => a.id === c.account);
    if (!account) {
      problems.push(`The memory account "${c.account}" is not set up for this organization. Set it up on the Memory page first`);
    } else if (typeof c.retentionDays === 'number' && c.retentionDays > 0 && !account.canExpire) {
      problems.push(`${account.name ?? memoryAccountName(account.id)} has no way to delete one memory, so its memories are kept until deleted there`);
    }
  }
  return problems;
}
