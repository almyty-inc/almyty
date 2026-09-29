import type { Agent } from '../../entities/agent.entity';
import type { AgentRun } from '../../entities/agent-run.entity';
import type { ChatRequest } from '../llm-providers/llm-providers.service';
import { MemoryError, type Provenance, type RankedItem, type ScopeRef, type Tier } from '../memory/canonical/canonical.types';
import type { PutInput } from '../memory/canonical/dto/canonical-memory.dto';
import { legacyTypeToTier, type AgentRuntimeService } from './agent-runtime.service';
import type { AutonomousStrategyRunner } from './autonomous-strategy.runner';
import type { ModelRoleCall, Team } from './autonomous-team';
import { stampOf } from './autonomous-team';
import {
  NATIVE_MEMORY_ACCOUNT,
  type AgentMemoryConfig,
  type MemorySettings,
  memoryScopeFor,
  memorySettings,
  retentionSeconds,
} from './agent-memory-settings';
import { runMayWriteSharedMemory } from './memory-autosave.policy';

/** The most facts one run adds. */
export const FACTS_PER_RUN_MAX = 5;

/** What the screening call answers when nothing may be kept. */
const NOTHING = 'NOTHING';

const asText = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));

function rulesBlock(rules: string[]): string {
  return rules.map((r) => `- ${r}`).join('\n');
}

export function screenPrompt(rules: string[]): string {
  return (
    'You check text before an assistant saves it to its memory. Remove everything the rules below cover, ' +
    'and return the rest exactly as it was, with nothing added. If nothing is left, answer with the single word ' +
    `${NOTHING}.\n\nNever save:\n${rulesBlock(rules)}`
  );
}

export function factsPrompt(rules: string[]): string {
  return (
    'You pick out what is worth remembering from one exchange between a person and an assistant: lasting facts, ' +
    'preferences and decisions that would help in a later conversation. Each fact is one short sentence that makes ' +
    `sense on its own. Answer with JSON only: {"facts": ["..."]}, at most ${FACTS_PER_RUN_MAX} facts, or {"facts": []} ` +
    'when nothing is worth keeping.' +
    (rules.length ? `\n\nNever include anything these rules cover:\n${rulesBlock(rules)}` : '')
  );
}

/** The facts in a facts call's answer; [] when it is not the asked-for shape. */
export function parseFacts(content: string): string[] {
  const text = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed?.facts)) return [];
    return parsed.facts
      .filter((f: unknown): f is string => typeof f === 'string' && f.trim().length > 0)
      .map((f: string) => f.trim())
      .slice(0, FACTS_PER_RUN_MAX);
  } catch {
    return [];
  }
}

/**
 * An autonomous agent's memory, as its Memory section says: whose memory a
 * run reads and writes (memoryScopeFor), the account it lives in, what is
 * saved after a run (facts, the conversation, or nothing unless asked),
 * the never-save rules every save is screened against, and how long a
 * saved memory is kept.
 *
 * Constructed per step next to the strategy runner, whose `callModel`
 * makes the screening and facts calls on the agent's main role, so they
 * are charged to the run and to that role like any other call.
 */
export class AgentMemoryKeeper {
  constructor(
    private readonly s: AgentRuntimeService,
    private readonly runner: AutonomousStrategyRunner,
  ) {}

  settings(agent: Pick<Agent, 'memoryConfig'>): MemorySettings {
    return memorySettings(agent.memoryConfig as AgentMemoryConfig);
  }

  /** The "Relevant memories" block for this step's prompt, or '' . */
  async recallContext(agent: Agent, run: AgentRun, query: string): Promise<string> {
    const scope = memoryScopeFor(agent, run);
    if (!scope || !query.trim()) return '';
    try {
      const ranked = await this.search(agent, run, scope, query, 5);
      if (ranked.length === 0) return '';
      return '\n\n## Relevant Memories\n' + ranked.map((r) => `- [${r.item.tier ?? 'memory'}] ${r.item.content}`).join('\n');
    } catch (err: any) {
      this.s.logger.warn(`Failed to recall memories for run ${run.id}: ${err?.message ?? err}`);
      return '';
    }
  }

  /** The recall_memory tool. */
  async recall(agent: Agent, run: AgentRun, params: Record<string, any>): Promise<{ result?: any; error?: string }> {
    const scope = memoryScopeFor(agent, run);
    if (!scope) return { result: null, error: 'There is no memory to search on this run' };
    try {
      const ranked = await this.search(agent, run, scope, String(params.query ?? ''), Number(params.limit) || 5);
      if (ranked.length === 0) return { result: 'No relevant memories found.' };
      return {
        result: ranked
          .map((r, i) => `${i + 1}. [${r.item.tier ?? 'memory'}] (score: ${r.score.toFixed(2)}) ${r.item.content}`)
          .join('\n'),
      };
    } catch (err: any) {
      return { result: null, error: `Failed to recall memory: ${err?.message ?? err}` };
    }
  }

  /** The store_memory tool: screened against the never-save rules, then saved. */
  async store(agent: Agent, run: AgentRun, team: Team, params: Record<string, any>): Promise<{ result?: any; error?: string }> {
    const scope = memoryScopeFor(agent, run);
    if (!scope) return { result: null, error: 'There is no memory to save to on this run' };
    // A visitor's run does not write memory unless the product opted its
    // visitors in -- the rule every save follows.
    if (!runMayWriteSharedMemory(run)) return { result: null, error: 'memory is not kept for visitor conversations' };
    const content = String(params.content ?? '').trim();
    if (!content) return { result: null, error: 'Nothing to save' };
    const s = this.settings(agent);
    const kept = await this.screen(run, team.main, content, s.neverSave);
    if (kept === null) return { result: 'Not saved: the agent is told never to save that.' };
    try {
      const item = await this.put(agent, run, scope, s, kept, legacyTypeToTier(params.type as string | undefined), Array.isArray(params.tags) ? params.tags : [], 'store_memory');
      return { result: `Memory stored (id: ${item.id})` };
    } catch (err: any) {
      if (err instanceof MemoryError) return { result: null, error: `memory rejected: ${err.tag.kind}` };
      return { result: null, error: `Failed to store memory: ${err?.message ?? err}` };
    }
  }

  /**
   * What a finished run leaves in memory: its facts, or the exchange as
   * said, per the agent's "what gets saved". Recorded as a `memory_save`
   * step. Never throws; a save that fails is logged.
   */
  async afterRun(agent: Agent, run: AgentRun, team: Team): Promise<void> {
    const s = this.settings(agent);
    if (!s.enabled || s.save === 'asked') return;
    // An explorer's own run works for its parent; the parent saves.
    if (run.metadata?.actAs) return;
    const scope = memoryScopeFor(agent, run);
    if (!scope || !runMayWriteSharedMemory(run)) return;
    const input = asText(run.input).trim();
    const output = asText(run.output).trim();
    if (!input && !output) return;
    const exchange = `Person: ${input}\nAgent: ${output}`;
    const startedAt = Date.now();
    const costBefore = run.totalCost || 0;

    let entries: string[] = [];
    let dropped = false;
    if (s.save === 'facts') {
      const answer = await this.runner.callModel(run, team.main, request(factsPrompt(s.neverSave), exchange));
      entries = answer.error ? [] : parseFacts(answer.content);
    } else {
      const kept = await this.screen(run, team.main, exchange, s.neverSave);
      if (kept === null) dropped = true;
      else entries = [kept];
    }

    let saved = 0;
    for (const content of entries) {
      try {
        await this.put(
          agent,
          run,
          scope,
          s,
          content,
          s.save === 'facts' ? 'long' : 'project',
          ['auto-saved', s.save === 'facts' ? 'fact' : 'conversation'],
          s.save === 'facts' ? 'auto_save_facts' : 'auto_save_conversation',
        );
        saved++;
      } catch (err: any) {
        this.s.logger.warn(`Failed to save memory for run ${run.id}: ${err?.message ?? err}`);
      }
    }
    run.steps.push({
      type: 'memory_save',
      role: stampOf(team.main),
      input: { save: s.save, scope: scope.scope_type, account: s.account },
      output: { saved, ...(dropped ? { dropped: 'never-save rules' } : {}) },
      cost: (run.totalCost || 0) - costBefore,
      duration: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * `text` with whatever the never-save rules cover taken out, by the
   * agent's main model; null when nothing may be kept, or when the check
   * could not be made (a save that was not checked is not made).
   */
  private async screen(run: AgentRun, main: ModelRoleCall, text: string, rules: string[]): Promise<string | null> {
    if (rules.length === 0) return text;
    const answer = await this.runner.callModel(run, main, request(screenPrompt(rules), text));
    if (answer.error) return null;
    const kept = answer.content.trim();
    if (!kept || kept.toUpperCase() === NOTHING) return null;
    return kept;
  }

  private search(agent: Agent, run: AgentRun, scope: ScopeRef, query: string, topK: number): Promise<RankedItem[]> {
    const s = this.settings(agent);
    const q = { scope, query, mode: 'memory' as const, top_k: topK };
    if (this.s.memoryAccounts) return this.s.memoryAccounts.search(run.organizationId, s.account, q);
    if (s.account !== NATIVE_MEMORY_ACCOUNT) throw new Error(`The memory account "${s.account}" is not reachable here`);
    return this.s.memoryService.search(q);
  }

  private async put(
    agent: Agent,
    run: AgentRun,
    scope: ScopeRef,
    s: MemorySettings,
    content: string,
    tier: Tier,
    tags: string[],
    via: string,
  ): Promise<{ id: string }> {
    const provenance: Provenance = {
      agent_id: agent.id,
      session_id: run.id,
      collab_id: null,
      model: null,
      provider: null,
      tool_chain: [via],
      created_by: 'agent',
      source_backend: s.account,
    };
    const input: PutInput = {
      mode: 'memory',
      scope,
      content,
      tier,
      tags,
      metadata: { source: { type: 'agent_runtime', id: run.id, name: agent.name } },
      provenance,
    };
    const actor = { user_id: run.userId ?? undefined };
    const ttl = retentionSeconds(s);
    if (this.s.memoryAccounts) {
      return this.s.memoryAccounts.put(run.organizationId, s.account, input, actor, { agentId: agent.id, expiresInSeconds: ttl });
    }
    if (s.account !== NATIVE_MEMORY_ACCOUNT) throw new Error(`The memory account "${s.account}" is not reachable here`);
    return this.s.memoryService.put({ ...input, ttl_seconds: ttl }, actor);
  }
}

function request(system: string, user: string): ChatRequest {
  return {
    messages: [
      { role: 'system' as any, content: system },
      { role: 'user' as any, content: user },
    ],
    skipToolExecution: true,
  };
}
