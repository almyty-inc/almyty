/**
 * The write policy of code mode (docs/design/code-mode.md, part D, and
 * decision 5): what happens to each call a script makes, decided per call
 * from the tool's side-effect class.
 *
 *   read          runs
 *   write         allow (the default), stage, or deny
 *   destructive   stage (the default), allow, or deny
 *
 * A per-tool exception wins over its class. Staging writes is an explicit
 * switch (`writes.write: 'stage'`), off by default; destructive calls are
 * staged unless someone says otherwise. A grant lets a tool's calls through
 * without staging, up to a number per run ("allow tickets.create, at most
 * 20 per run"); a denied call is never let through by a grant.
 *
 * Lives on the agent as `agentConfig.codeMode`.
 */
export type WriteAction = 'allow' | 'stage' | 'deny';

export interface CodeModeConfig {
  writes?: {
    write?: WriteAction;
    destructive?: WriteAction;
    /** Per tool id: wins over the class. */
    tools?: Record<string, WriteAction>;
  };
  /** Calls of a tool let through without staging, at most `max` per run. */
  grants?: Array<{ toolId: string; max: number }>;
  /**
   * The model extract() uses (decision 11): pinned when set; otherwise the
   * organization's routing policy picks the cheapest selectable model.
   */
  extractor?: { providerId: string; model?: string } | null;
}

export type SideEffect = 'read' | 'write' | 'destructive';

export interface CallDecision {
  action: 'run' | 'stage' | 'deny';
  /** The run was let through by a grant (its count is used). */
  viaGrant?: boolean;
}

const ACTIONS: readonly WriteAction[] = ['allow', 'stage', 'deny'];

/** What the policy says about one call; `grantsLeft` is decremented when a grant is used. */
export function decideCall(
  sideEffect: SideEffect | null | undefined,
  toolId: string,
  config: CodeModeConfig | null | undefined,
  grantsLeft: Map<string, number>,
): CallDecision {
  const cls: SideEffect = sideEffect === 'read' || sideEffect === 'destructive' ? sideEffect : 'write';
  if (cls === 'read') return { action: 'run' };
  const exception = config?.writes?.tools?.[toolId];
  const byClass = cls === 'destructive' ? (config?.writes?.destructive ?? 'stage') : (config?.writes?.write ?? 'allow');
  const action: WriteAction = exception && ACTIONS.includes(exception) ? exception : ACTIONS.includes(byClass) ? byClass : 'stage';
  if (action === 'deny') return { action: 'deny' };
  if (action === 'allow') return { action: 'run' };
  const left = grantsLeft.get(toolId) ?? 0;
  if (left > 0) {
    grantsLeft.set(toolId, left - 1);
    return { action: 'run', viaGrant: true };
  }
  return { action: 'stage' };
}

/** A run's grants, minus what the run already used (`used`: tool id -> calls let through). */
export function grantsLeftFor(config: CodeModeConfig | null | undefined, used: Record<string, number> | null | undefined): Map<string, number> {
  const left = new Map<string, number>();
  for (const grant of config?.grants ?? []) {
    left.set(grant.toolId, Math.max(0, grant.max - (used?.[grant.toolId] ?? 0)));
  }
  return left;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What is wrong with an agent's code-mode settings, one sentence each (empty: nothing). */
export function codeModeProblems(config: unknown): string[] {
  if (config === undefined || config === null) return [];
  if (typeof config !== 'object' || Array.isArray(config)) return ['Code mode settings must be an object'];
  const c = config as CodeModeConfig;
  const problems: string[] = [];
  const writes = c.writes;
  if (writes !== undefined && writes !== null) {
    for (const key of ['write', 'destructive'] as const) {
      if (writes[key] !== undefined && !ACTIONS.includes(writes[key] as WriteAction)) {
        problems.push(`What happens to ${key === 'write' ? 'changes' : 'deletions'} must be allow, stage or deny`);
      }
    }
    if (writes.tools !== undefined) {
      const ok =
        writes.tools &&
        typeof writes.tools === 'object' &&
        Object.entries(writes.tools).every(([id, action]) => UUID_RE.test(id) && ACTIONS.includes(action as WriteAction));
      if (!ok) problems.push('Per-tool exceptions must map tool ids to allow, stage or deny');
    }
  }
  if (c.grants !== undefined) {
    const ok =
      Array.isArray(c.grants) &&
      c.grants.every((g) => g && typeof g.toolId === 'string' && UUID_RE.test(g.toolId) && Number.isInteger(g.max) && g.max > 0 && g.max <= 100_000);
    if (!ok) problems.push('Each allowance needs a tool and a whole number of calls from 1 to 100,000');
  }
  if (c.extractor !== undefined && c.extractor !== null) {
    const e = c.extractor;
    if (typeof e !== 'object' || typeof e.providerId !== 'string' || !UUID_RE.test(e.providerId) || (e.model !== undefined && typeof e.model !== 'string')) {
      problems.push('The model for extract() must name a provider connection');
    }
  }
  return problems;
}
