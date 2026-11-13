import type { Agent } from '../../entities/agent.entity';
import { Not } from 'typeorm';
import { AgentRunStatus, type AgentRun } from '../../entities/agent-run.entity';
import type { ChatRequest } from '../llm-providers/llm-providers.service';
import { MemoryError, type MemoryItem, type Provenance, type RankedItem, type ScopeRef, type Tier } from '../memory/canonical/canonical.types';
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
import { principalOfRun } from '../../common/authorization/execution-access.service';
import type { AgentAccountUse } from '../memory/canonical/memory-accounts.service';
import { reportedItemsOf } from './answer-checks';
import { runEvidence } from './checker-evidence';

/** The most facts one run adds. */
export const FACTS_PER_RUN_MAX = 5;

/** What kind of memory a store_memory call says it saves; the tool's own enum. */
export const MEMORY_KINDS = ['fact', 'preference', 'context', 'episode', 'instruction'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** The kind a store_memory call asked for, or undefined for none or one outside the enum. */
export function memoryKindOf(value: unknown): MemoryKind | undefined {
  return typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value) ? (value as MemoryKind) : undefined;
}

/** What the screening call answers when nothing may be kept. */
const NOTHING = 'NOTHING';

const asText = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));

/**
 * What a person wrote on this run, for the facts and conversation saves.
 * A run someone started carries their words as its input. An always-on
 * run's input is the wake prompt the system wrote; the only person's words
 * in it are the owner's messages, which the run carries in
 * `metadata.personWords` (AlwaysOnService). '' when nobody wrote anything.
 */
export function personWordsOf(run: Pick<AgentRun, 'input' | 'metadata'>): string {
  if (run.metadata?.triggerType === 'always_on') {
    const words = run.metadata?.personWords;
    if (!Array.isArray(words)) return '';
    return words
      .filter((w: unknown): w is string => typeof w === 'string' && w.trim().length > 0)
      .map((w: string) => w.trim())
      .join('\n\n');
  }
  return asText(run.input).trim();
}

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
    'sense on its own and keeps the specifics: names, ids, versions, dates and numbers as the exchange gave them. ' +
    'A fact too vague to act on later ("the user is interested in a topic") is not worth keeping, and neither is ' +
    'a guess or a conclusion the exchange does not back. ' +
    'Never keep the state of a tool, a service or a call as a fact: an error, a timeout, an outage, a rate limit, ' +
    'a search that failed or found nothing, or what the assistant could not do. It was true for a moment, and a later ' +
    `conversation would read it as lasting. Answer with JSON only: {"facts": ["..."]}, at most ${FACTS_PER_RUN_MAX} facts, or {"facts": []} ` +
    'when nothing is worth keeping.' +
    (rules.length ? `\n\nNever include anything these rules cover:\n${rulesBlock(rules)}` : '')
  );
}

/**
 * Whether the answer a run finished with failed its verification: the last
 * verdict on the answer (not a mid-run advisory one) is not a pass. The
 * panel ran out of revisions with its checks still failing, and the run
 * completed with an answer the checks refuted.
 */
export function verificationFailed(run: Pick<AgentRun, 'steps' | 'metadata'>): boolean {
  // A cascade's failed draft is not the answer: the stronger model answered
  // instead (escalateTo), so that verdict says nothing about what was kept.
  const verdicts = (run.steps ?? []).filter((st) => st?.type === 'verify' && st.output?.advisory !== true && !st.output?.escalateTo);
  const last = verdicts[verdicts.length - 1];
  if (last) return last.output?.verdict !== 'pass';
  const meta = run.metadata?.verify?.verdict;
  return typeof meta === 'string' && meta !== 'pass';
}

/**
 * The tools of the agent the run called that never returned a result:
 * every call of each errored. A tool the agent has (a `toolId` on the
 * step) is what the answer draws on; the built-in memory and agent tools
 * are not. An answer that says "the search timed out" can pass its check
 * (it is honest) and still leave nothing worth remembering: the facts
 * saved from runs 6c7bd4a5 and b8cc6429 were "the assistant experienced a
 * server timeout error".
 */
export function failedTools(run: Pick<AgentRun, 'steps'>): string[] {
  const calls = new Map<string, { name: string; ok: boolean }>();
  for (const step of run.steps ?? []) {
    if (step?.type !== 'tool_call' || !step.input?.toolId) continue;
    const id = String(step.input.toolId);
    const seen = calls.get(id) ?? { name: String(step.input.tool ?? step.input.toolName ?? id), ok: false };
    if (!step.error) seen.ok = true;
    calls.set(id, seen);
  }
  return Array.from(calls.values())
    .filter((c) => !c.ok)
    .map((c) => c.name);
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

/** The most item ids one run records as reported. */
export const REPORTED_ITEMS_MAX = 50;
/** How many of the agent's earlier runs a run is told the reported items of, newest first, and the most ids that makes. */
export const REPORTED_RUNS_MAX = 20;
export const REPORTED_IDS_MAX = 200;

/**
 * The items a finished run's answer reported, by the one id each is best
 * known by (an OpenAlex id, else an issue number, else a DOI), from the
 * items its tool results identify. [] when the answer lists none.
 */
export function reportedItemIds(run: Pick<AgentRun, 'input' | 'output' | 'steps'>): string[] {
  const answer = asText(run.output).trim();
  if (!answer) return [];
  return reportedItemsOf(answer, runEvidence(run as any))
    .map((it) => it.id)
    .slice(0, REPORTED_ITEMS_MAX);
}

/**
 * Keeps on the finished run (`metadata.reportedItems`) the ids of the
 * items its answer reported. They are state, not a memory: every later run
 * of the agent is given them (AgentMemoryKeeper.reportedBefore), where a
 * memory of them lost the similarity ranking to prose facts and no run
 * ever saw it (rc8, runs bc75f6f1 to d13c5d50).
 */
export function recordReportedItems(run: AgentRun): void {
  const ids = reportedItemIds(run);
  if (!ids.length) return;
  run.metadata = { ...(run.metadata ?? {}), reportedItems: ids };
}

/** The "Items you already reported" block a run's prompt carries, or '' when there are none. */
export function reportedBlock(ids: string[]): string {
  if (!ids.length) return '';
  return (
    '\n\n## Items you already reported\n' +
    'Your earlier answers reported these items, newest first. Leave out any of them your tools return again, and say how many you left out:\n' +
    ids.join(', ')
  );
}
/** The most of one recalled memory put in front of the model. */
export const RECALL_ITEM_MAX_CHARS = 2000;

/** What kind of memory a recalled item is, as the model reads it: a document, or a fact's tier. */
export function recallLabel(item: Pick<MemoryItem, 'mode' | 'tier'>): string {
  return item.mode === 'document' ? 'document' : item.tier ?? 'memory';
}

/** A recalled item's text, cut at RECALL_ITEM_MAX_CHARS: a document copied in whole from another store is one long row. */
export function recallText(item: Pick<MemoryItem, 'content'>): string {
  const text = item.content ?? '';
  return text.length > RECALL_ITEM_MAX_CHARS ? `${text.slice(0, RECALL_ITEM_MAX_CHARS)}…` : text;
}

/** The "Relevant Memories" block a prompt carries, or '' when nothing was found. */
export function recallBlock(ranked: Array<Pick<RankedItem, 'item'>>): string {
  if (ranked.length === 0) return '';
  return '\n\n## Relevant Memories\n' + ranked.map((r) => `- [${recallLabel(r.item)}] ${recallText(r.item)}`).join('\n');
}

/**
 * What a run's memory lookup searches with: what the person asked. A run
 * started with `{ message }` is searched with the message, not its JSON;
 * an always-on run with the owner's words only (personWordsOf). '' when
 * the run carries none.
 */
export function recallQueryOf(run: Pick<AgentRun, 'input' | 'metadata'>): string {
  if (run.metadata?.triggerType === 'always_on') return personWordsOf(run);
  const input = run.input as unknown;
  if (typeof input === 'string') return input.trim();
  if (input && typeof input === 'object' && typeof (input as { message?: unknown }).message === 'string') {
    return ((input as { message: string }).message).trim();
  }
  return asText(input).trim();
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
      return recallBlock(ranked);
    } catch (err: any) {
      this.s.logger.warn(`Failed to recall memories for run ${run.id}: ${err?.message ?? err}`);
      return '';
    }
  }

  /**
   * The memories a run starts with, when memory is on: looked up once, at
   * the start of the run, with what the person asked (recallQueryOf; the
   * conversation's last message when the run carries no words of its own),
   * and kept on the run so every later step reads the same block. Asked on
   * every step instead, the newest user message was a verifier's feedback
   * by the second answer. Recorded as a `memory_recall` step, so the run
   * shows it looked and how many memories it found. A lookup that fails is
   * recorded too, and the run goes on without memories.
   */
  async recallAtStart(agent: Agent, run: AgentRun, conversationQuery: () => Promise<string>): Promise<string> {
    const held = run.workingMemory?.memoryRecall;
    if (held && typeof held.context === 'string') return held.context;
    const s = this.settings(agent);
    if (!s.enabled) return '';
    const scope = memoryScopeFor(agent, run);
    if (!scope) return '';
    const startedAt = Date.now();
    let query = recallQueryOf(run);
    let ranked: RankedItem[] = [];
    let error: string | undefined;
    try {
      if (!query) query = (await conversationQuery()).trim();
      if (query) ranked = await this.search(agent, run, scope, query, 5);
    } catch (err: any) {
      error = `Failed to recall memories: ${err?.message ?? err}`;
      this.s.logger.warn(`${error} (run ${run.id})`);
    }
    // What the agent reported before, by id, always: not ranked against the
    // request like a memory, which prose facts outranked every time.
    const reported = await this.reportedBefore(agent, run);
    const context = recallBlock(ranked) + reportedBlock(reported);
    run.workingMemory = { ...(run.workingMemory ?? {}), memoryRecall: { context, found: ranked.length, reportedItems: reported.length } };
    run.steps.push({
      type: 'memory_recall',
      input: { scope: scope.scope_type, account: s.account },
      output: { found: ranked.length, reportedItems: reported.length, ...(query ? {} : { skipped: 'nothing to search with' }) },
      duration: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
      ...(error ? { error } : {}),
    });
    return context;
  }

  /**
   * The ids of the items this agent's earlier completed runs reported
   * (their `metadata.reportedItems`), newest first, without repeats: the
   * last REPORTED_RUNS_MAX runs, at most REPORTED_IDS_MAX ids. For a memory
   * that is each person's own, only the runs of the same person or
   * visitor. [] when they cannot be read.
   */
  async reportedBefore(agent: Pick<Agent, 'id' | 'memoryConfig'>, run: AgentRun): Promise<string[]> {
    if (!this.s.runRepository) return [];
    const s = this.settings(agent);
    const own = s.whose === 'person' && run.principal?.kind !== 'agent';
    if (own && !run.userId && !run.endUserId) return [];
    try {
      const rows = await this.s.runRepository.find({
        where: {
          agentId: agent.id,
          organizationId: run.organizationId,
          status: AgentRunStatus.COMPLETED,
          id: Not(run.id),
          ...(own ? (run.userId ? { userId: run.userId } : { endUserId: run.endUserId }) : {}),
        } as any,
        select: { id: true, metadata: true, createdAt: true } as any,
        order: { createdAt: 'DESC' } as any,
        take: REPORTED_RUNS_MAX,
      });
      const ids: string[] = [];
      for (const row of rows as AgentRun[]) {
        const listed = row.metadata?.reportedItems;
        if (!Array.isArray(listed)) continue;
        for (const id of listed) if (typeof id === 'string' && !ids.includes(id) && ids.length < REPORTED_IDS_MAX) ids.push(id);
      }
      return ids;
    } catch (err: any) {
      this.s.logger.warn(`Failed to read what agent ${agent.id} reported before, for run ${run.id}: ${err?.message ?? err}`);
      return [];
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
          .map((r, i) => `${i + 1}. [${recallLabel(r.item)}] (score: ${r.score.toFixed(2)}) ${recallText(r.item)}`)
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
      const kind = memoryKindOf(params.type);
      const item = await this.put(agent, run, scope, s, kept, legacyTypeToTier(kind), Array.isArray(params.tags) ? params.tags : [], 'store_memory', kind);
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
    // Only what a person wrote is theirs. An always-on run's input is the
    // wake prompt the system wrote ("You are always on, and something woke
    // you..."); read as the person's words it became facts about them.
    const input = personWordsOf(run);
    // Nothing a person said: nothing to learn about them.
    if (!input) return;
    // An answer the verification panel rejected (it ran out of revisions
    // with the checks still failing) is not saved: facts drawn from it carry
    // the very conclusion the checks refuted, and a later run would recall
    // it as true. Nor is a run whose tool never answered: what it leaves is
    // the outage, not a fact (failedTools).
    const broken = failedTools(run);
    const skipped = verificationFailed(run)
      ? 'the answer did not pass verification'
      : broken.length
        ? `a tool call failed: ${broken.join(', ')}`
        : null;
    if (skipped) {
      run.steps.push({
        type: 'memory_save',
        role: stampOf(team.main),
        input: { save: s.save, scope: scope.scope_type, account: s.account },
        output: { saved: 0, skipped },
        cost: 0,
        duration: 0,
        timestamp: new Date().toISOString(),
      });
      return;
    }
    const output = asText(run.output).trim();
    const exchange = `Person: ${input}\nAgent: ${output}`;
    const startedAt = Date.now();
    const costBefore = run.totalCost || 0;

    let entries: string[] = [];
    let dropped = false;
    // The ids of the items the answer reported are not a fact to rank by
    // similarity: they are the run's reportedItems (recordReportedItems),
    // and every later run of the agent is given them (reportedBlock).
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
          s.save === 'facts' ? 'fact' : 'episode',
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

  /** The agent's own account, when it has one, used as the run's principal. */
  private accountUse(agent: Agent, run: AgentRun, s: MemorySettings): AgentAccountUse {
    return s.credentialId ? { credentialId: s.credentialId, agentId: agent.id, principal: principalOfRun(run) } : {};
  }

  /**
   * Facts and documents alike, in the run's scope. A document someone
   * added on the Memory page lives in almyty's own store (outside memory
   * services keep facts only), so an agent whose memories go to an
   * outside account looks there for facts and here for documents.
   */
  private async search(agent: Agent, run: AgentRun, scope: ScopeRef, query: string, topK: number): Promise<RankedItem[]> {
    const s = this.settings(agent);
    if (s.account === NATIVE_MEMORY_ACCOUNT) {
      const q = { scope, query, top_k: topK };
      if (this.s.memoryAccounts) return this.s.memoryAccounts.search(run.organizationId, s.account, q, this.accountUse(agent, run, s));
      return this.s.memoryService.search(q);
    }
    if (!this.s.memoryAccounts) throw new Error(`The memory account "${s.account}" is not reachable here`);
    const facts = await this.s.memoryAccounts.search(
      run.organizationId,
      s.account,
      { scope, query, mode: 'memory' as const, top_k: topK },
      this.accountUse(agent, run, s),
    );
    let documents: RankedItem[] = [];
    try {
      documents = await this.s.memoryService.search({ scope, query, mode: 'document' as const, top_k: topK });
    } catch (err: any) {
      this.s.logger.warn(`Failed to search documents for run ${run.id}: ${err?.message ?? err}`);
    }
    // Scores from two stores do not compare; take them in turn, best first.
    const merged: RankedItem[] = [];
    for (let i = 0; merged.length < topK && (i < facts.length || i < documents.length); i++) {
      if (i < facts.length) merged.push(facts[i]);
      if (i < documents.length && merged.length < topK) merged.push(documents[i]);
    }
    return merged;
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
    kind?: MemoryKind,
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
      // What kind of memory it is (fact, preference, ...): the tier keeps how
      // long it lasts, this keeps what it is, for the agent's Memory tab.
      metadata: { source: { type: 'agent_runtime', id: run.id, name: agent.name }, ...(kind ? { type: kind } : {}) },
      provenance,
    };
    const actor = { user_id: run.userId ?? undefined };
    const ttl = retentionSeconds(s);
    if (this.s.memoryAccounts) {
      return this.s.memoryAccounts.put(run.organizationId, s.account, input, actor, {
        agentId: agent.id,
        runId: run.id,
        expiresInSeconds: ttl,
        ...this.accountUse(agent, run, s),
      });
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
