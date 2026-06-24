import { Injectable, Logger } from '@nestjs/common';

import { AgentRun } from '../../entities/agent-run.entity';
import { LlmProvidersService } from '../llm-providers/llm-providers.service';

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
}

/** Cached, incrementally-grown summary of the conversation prefix. */
interface ContextSummaryCache {
  coveredCount: number; // how many leading history messages are folded into `text`
  text: string;
}

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
    userId?: string,
    signal?: AbortSignal,
  ): Promise<{ messages: any[]; cost: number; tokens: number; compacted: boolean }> {
    const noop = { messages, cost: 0, tokens: 0, compacted: false };
    if (!config?.enabled || messages.length < 2) return noop;

    const budget = config.maxContextTokens ?? DEFAULTS.maxContextTokens;
    const keepRecent = Math.max(1, config.keepRecentMessages ?? DEFAULTS.keepRecentMessages);
    const strategy = config.strategy ?? DEFAULTS.strategy;

    const system = messages[0];
    const history = messages.slice(1);

    let cache: ContextSummaryCache = run.workingMemory?.contextSummary ?? {
      coveredCount: 0,
      text: '',
    };
    // Guard against a stale cache that claims to cover more than exists.
    if (cache.coveredCount > history.length) cache = { coveredCount: 0, text: '' };

    const render = (c: ContextSummaryCache) => {
      const sys =
        c.coveredCount > 0
          ? { ...system, content: `${system.content}\n\n[EARLIER CONVERSATION SUMMARY]\n${c.text}` }
          : system;
      return [sys, ...history.slice(c.coveredCount)];
    };

    let current = render(cache);
    if (this.estimateTokens(current) <= budget) {
      return { messages: current, cost: 0, tokens: 0, compacted: cache.coveredCount > 0 };
    }

    // Over budget: advance the covered boundary to a pair-safe point that keeps
    // at least `keepRecent` messages in the verbatim tail.
    const target = history.length - keepRecent;
    const boundary = this.safeBoundary(history, target);
    if (boundary <= cache.coveredCount) {
      // Can't compact further (the tail alone exceeds the budget). Best effort.
      return { messages: current, cost: 0, tokens: 0, compacted: cache.coveredCount > 0 };
    }

    const toCompact = history.slice(cache.coveredCount, boundary);
    let addedText: string;
    let cost = 0;
    let tokens = 0;

    if (strategy === 'truncate') {
      addedText = `[${toCompact.length} earlier message(s) omitted]`;
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
        addedText = summary.text;
        cost = summary.cost;
        tokens = summary.tokens;
      } catch (err: any) {
        this.logger.warn(
          `Context summarization failed for run ${run.id}; falling back to truncation: ${err?.message}`,
        );
        addedText = `[${toCompact.length} earlier message(s) omitted]`;
      }
    }

    const newCache: ContextSummaryCache = {
      coveredCount: boundary,
      text: cache.text ? `${cache.text}\n${addedText}` : addedText,
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
    userId: string | undefined,
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
