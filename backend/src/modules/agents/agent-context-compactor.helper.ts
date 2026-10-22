import { Injectable, Logger } from '@nestjs/common';

import { AgentRun } from '../../entities/agent-run.entity';
import { LlmProvidersService } from '../llm-providers/llm-providers.service';
import type { ExecutionPrincipal } from '../../common/authorization/execution-access.service';

/**
 * Per-agent context-compaction config (lives in `agent.modelConfig.compaction`,
 * a JSON column — no migration). Disabled unless `enabled` is true, so existing
 * runs are unaffected until an agent opts in.
 */
export interface CompactionConfig {
  enabled?: boolean;
  /** Token budget for the assembled context. Over this, the old prefix is compacted. Default 12000. */
  maxContextTokens?: number;
  /** Minimum most-recent messages always kept verbatim. Default 8. */
  keepRecentMessages?: number;
  /** 'summarize' (LLM) condenses the prefix; 'truncate' drops it with a count note. Default 'summarize'. */
  strategy?: 'summarize' | 'truncate';
  /** Provider/model for the summary call. Defaults to the agent's own provider. */
  providerId?: string;
  model?: string;
  /**
   * Cut a tool result from an earlier run of the conversation to this many
   * characters (this run's own results stay whole). Off unless set; an
   * always-on standing thread uses 2000.
   */
  earlierToolResultChars?: number;
}

/** Cached, incrementally-grown summary of the conversation prefix. */
export interface ContextSummaryCache {
  coveredCount: number; // how many leading history messages are folded into `text`
  text: string;
  /** The last message the summary covers, and when it was written: how a later step or run finds where the summary ends. */
  throughId?: string;
  throughAt?: string;
  /** Truncation: how many messages it has dropped so far. */
  omitted?: number;
}

/**
 * The stored message a history entry was built from. AgentRuntimeBuilders
 * puts these on each entry as non-enumerable properties, so they never
 * reach a provider, which is sent the entries as they are.
 */
const MESSAGE_ID = 'messageId';
const MESSAGE_AT = 'messageAt';

export function tagStoredMessage(entry: Record<string, any>, message: { id?: string; createdAt?: Date | string | null }): void {
  if (message.id) Object.defineProperty(entry, MESSAGE_ID, { value: String(message.id), enumerable: false });
  if (message.createdAt) {
    Object.defineProperty(entry, MESSAGE_AT, { value: new Date(message.createdAt).toISOString(), enumerable: false });
  }
}

function messageIdOf(entry: any): string | undefined {
  return entry?.[MESSAGE_ID];
}

function coveredThrough(entry: any): Pick<ContextSummaryCache, 'throughId' | 'throughAt'> {
  const id = messageIdOf(entry);
  const at = entry?.[MESSAGE_AT];
  return { ...(id ? { throughId: id } : {}), ...(at ? { throughAt: at } : {}) };
}

/** How many leading entries were written no later than `through`. */
function coveredByTime(history: any[], through: string | undefined): number {
  if (!through) return 0;
  let n = 0;
  while (n < history.length && typeof history[n]?.[MESSAGE_AT] === 'string' && history[n][MESSAGE_AT] <= through) n++;
  return n;
}

/**
 * A tool result an earlier run of the conversation got, cut to `limit`
 * characters. The run that called the tool read all of it and answered
 * from it; sent whole again on every step of every later run (an always-on
 * agent's last inbox listing, on each of the next wake's calls) it was most
 * of what those calls cost. This run's own results are never cut.
 */
function clipEarlierToolResults(history: any[], runStartedAt: Date | string | undefined, limit: number | undefined): any[] {
  if (!limit || limit <= 0 || !runStartedAt) return history;
  const since = new Date(runStartedAt).toISOString();
  return history.map((entry) => {
    const at = entry?.[MESSAGE_AT];
    if (entry?.role !== 'tool' || typeof entry.content !== 'string' || entry.content.length <= limit) return entry;
    if (typeof at !== 'string' || at >= since) return entry;
    const clipped = {
      ...entry,
      content: `${entry.content.slice(0, limit)}\n[cut: ${entry.content.length - limit} more characters of an earlier tool result]`,
    };
    tagStoredMessage(clipped, { id: messageIdOf(entry), createdAt: at });
    return clipped;
  });
}

/**
 * The summary an earlier run of the same conversation left, for a run that
 * has none yet. A standing thread (always on) or a chat is one run per
 * turn; each run started with no summary, so its first step summarized the
 * whole history window again -- most of the tokens a wake that only looked
 * at the inbox spent. Only a summary that names the message it ends at is
 * carried: a bare count means nothing in another run's window.
 */
export async function carriedContextSummary(
  runs: { find(options: any): Promise<Array<Pick<AgentRun, 'id' | 'workingMemory'>>> },
  run: Pick<AgentRun, 'id' | 'conversationId' | 'workingMemory'>,
): Promise<ContextSummaryCache | null> {
  if (!run.conversationId || run.workingMemory?.contextSummary) return null;
  const earlier = await runs.find({
    where: { conversationId: run.conversationId },
    order: { createdAt: 'DESC' },
    take: 5,
    select: { id: true, workingMemory: true },
  });
  for (const r of earlier) {
    if (r.id === run.id) continue;
    const summary = r.workingMemory?.contextSummary as ContextSummaryCache | undefined;
    if (summary?.throughId && summary.text) return summary;
  }
  return null;
}

/**
 * What an always-on standing thread is compacted with, under the agent's own
 * `modelConfig.compaction`: a wake reads the last listing it needs again,
 * so an earlier wake's tool results are cut (see clipEarlierToolResults).
 */
export const ALWAYS_ON_COMPACTION: CompactionConfig = { earlierToolResultChars: 2000 };

const DEFAULTS = {
  maxContextTokens: 12000,
  keepRecentMessages: 8,
  strategy: 'summarize' as const,
};

@Injectable()
export class AgentContextCompactor {
  private readonly logger = new Logger(AgentContextCompactor.name);

  constructor(private readonly llm: LlmProvidersService) {}

  /**
   * Compact an assembled message array (`[system, ...history]`) when it exceeds
   * the token budget. The old prefix is folded into the system message (as a
   * summary section — provider-safe, no mid-array role surprises) while a
   * verbatim recent tail is preserved. The summary is cached on
   * `run.workingMemory.contextSummary` and grown incrementally, so the LLM is
   * only called when the context actually crosses the budget again.
   *
   * Never throws: on a summarizer error it falls back to a truncation note so a
   * compaction failure can't wedge the run. Returns the (possibly unchanged)
   * messages plus any cost/tokens spent summarizing.
   */
  async compact(
    messages: any[],
    run: AgentRun,
    config: CompactionConfig,
    organizationId: string,
    /** Who the summarizer call acts as: the run's principal (see LlmChatHelper.chat). */
    userId?: string | ExecutionPrincipal,
    signal?: AbortSignal,
  ): Promise<{ messages: any[]; cost: number; tokens: number; compacted: boolean }> {
    const noop = { messages, cost: 0, tokens: 0, compacted: false };
    if (!config?.enabled || messages.length < 2) return noop;

    const budget = config.maxContextTokens ?? DEFAULTS.maxContextTokens;
    const keepRecent = Math.max(1, config.keepRecentMessages ?? DEFAULTS.keepRecentMessages);
    const strategy = config.strategy ?? DEFAULTS.strategy;

    const system = messages[0];
    const history = clipEarlierToolResults(messages.slice(1), run.createdAt, config.earlierToolResultChars);

    let cache: ContextSummaryCache = { ...(run.workingMemory?.contextSummary ?? { coveredCount: 0, text: '' }) };
    // Where the summary ends in this history. A summary that names the last
    // message it covers is found by that message: the history is the
    // newest N messages, so it shifts as the thread grows, and a summary
    // carried over from an earlier run of the thread (carriedContextSummary)
    // was counted against another window. When that message is no longer in
    // the window, everything the window holds came after it.
    if (cache.throughId) {
      const at = history.findIndex((m) => messageIdOf(m) === cache.throughId);
      cache.coveredCount = at >= 0 ? at + 1 : coveredByTime(history, cache.throughAt);
    } else if (cache.coveredCount > history.length) {
      // Guard against a stale cache that claims to cover more than exists.
      cache = { coveredCount: 0, text: '' };
    }

    const render = (c: ContextSummaryCache) => {
      const sys = c.text
        ? { ...system, content: `${system.content}\n\n[EARLIER CONVERSATION SUMMARY]\n${c.text}` }
        : system;
      return [sys, ...history.slice(c.coveredCount)];
    };

    let current = render(cache);
    if (this.estimateTokens(current) <= budget) {
      return { messages: current, cost: 0, tokens: 0, compacted: !!cache.text };
    }

    // Over budget: advance the covered boundary to a pair-safe point that keeps
    // at least `keepRecent` messages in the verbatim tail.
    const target = history.length - keepRecent;
    const boundary = this.safeBoundary(history, target);
    if (boundary <= cache.coveredCount) {
      // Can't compact further (the tail alone exceeds the budget). Best effort.
      return { messages: current, cost: 0, tokens: 0, compacted: !!cache.text };
    }

    const toCompact = history.slice(cache.coveredCount, boundary);
    // Summarize returns ONE summary with the prior one merged in, so it
    // replaces the text; appending it repeated the prior summary on every
    // compaction, and a standing thread's summary grew without end.
    // Truncation keeps one running count of what it dropped.
    let newText: string;
    let omitted = cache.omitted ?? 0;
    let cost = 0;
    let tokens = 0;

    if (strategy === 'truncate') {
      omitted += toCompact.length;
      newText = `[${omitted} earlier message(s) omitted]`;
    } else {
      try {
        const summary = await this.summarize(
          cache.text,
          toCompact,
          config,
          organizationId,
          userId,
          signal,
        );
        newText = summary.text;
        cost = summary.cost;
        tokens = summary.tokens;
      } catch (err: any) {
        this.logger.warn(
          `Context summarization failed for run ${run.id}; falling back to truncation: ${err?.message}`,
        );
        const note = `[${toCompact.length} earlier message(s) omitted]`;
        newText = cache.text ? `${cache.text}\n${note}` : note;
      }
    }

    const newCache: ContextSummaryCache = {
      coveredCount: boundary,
      ...coveredThrough(history[boundary - 1]),
      text: newText,
      ...(omitted ? { omitted } : {}),
    };
    run.workingMemory = { ...(run.workingMemory || {}), contextSummary: newCache };

    return { messages: render(newCache), cost, tokens, compacted: true };
  }

  /**
   * Pick the largest index <= `target` that is a clean turn boundary — a `user`
   * or `assistant` message — so the verbatim tail never starts with an orphan
   * tool-result whose tool_call was summarized away. Scans backward from
   * `target`; returns 0 if no safe boundary exists (caller then no-ops).
   */
  private safeBoundary(history: any[], target: number): number {
    for (let i = Math.min(target, history.length - 1); i > 0; i--) {
      const role = history[i]?.role;
      if (role === 'user' || role === 'assistant') return i;
    }
    return 0;
  }

  /** Rough token estimate (~4 chars/token) over the message contents. */
  private estimateTokens(messages: any[]): number {
    let chars = 0;
    for (const m of messages) {
      const c = m?.content;
      chars += (typeof c === 'string' ? c : JSON.stringify(c ?? '')).length;
      if (m?.toolCalls) chars += JSON.stringify(m.toolCalls).length;
    }
    return Math.ceil(chars / 4);
  }

  private async summarize(
    priorSummary: string,
    toCompact: any[],
    config: CompactionConfig,
    organizationId: string,
    userId: string | ExecutionPrincipal | undefined,
    signal?: AbortSignal,
  ): Promise<{ text: string; cost: number; tokens: number }> {
    const providerId = config.providerId;
    if (!providerId) {
      throw new Error('compaction has no providerId (and agent provider was not supplied)');
    }

    const systemPrompt =
      `You compact an AI agent's conversation transcript into dense working memory. ` +
      `Preserve: the task/goal, decisions made, tool calls and their key results, facts ` +
      `discovered, constraints, and any open threads. Drop pleasantries and verbatim ` +
      `boilerplate. Output prose or terse bullets, no preamble. If a prior summary is given, ` +
      `merge the new messages into it and return ONE updated summary.`;

    const transcript = toCompact
      .map((m) => {
        const role = m?.role ?? 'unknown';
        const content =
          typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '');
        const tc = m?.toolCalls ? ` toolCalls=${JSON.stringify(m.toolCalls)}` : '';
        return `${role}: ${content}${tc}`;
      })
      .join('\n');

    const userPrompt =
      (priorSummary ? `PRIOR SUMMARY:\n${priorSummary}\n\n` : '') +
      `NEW MESSAGES TO FOLD IN:\n${transcript}`;

    const response = await this.llm.chat(
      providerId,
      {
        messages: [
          { role: 'system' as any, content: systemPrompt },
          { role: 'user' as any, content: userPrompt },
        ],
        model: config.model,
        temperature: 0,
        signal,
      },
      organizationId,
      userId,
    );

    const text = response?.message?.content?.trim() || priorSummary || '[summary unavailable]';
    return { text, cost: response?.cost || 0, tokens: response?.usage?.totalTokens || 0 };
  }
}
