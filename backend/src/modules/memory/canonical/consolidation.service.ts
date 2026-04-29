import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThan, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { CanonicalMemory } from './canonical-memory.entity';
import { CanonicalMemoryService } from './canonical-memory.service';
import { LIMITS } from './canonical.constants';
import {
  MemoryItem,
  Provenance,
  ScopeRef,
} from './canonical.types';
import { LlmProvidersService, ChatRequest } from '../../llm-providers/llm-providers.service';
import { LlmProvider, LlmProviderStatus } from '../../../entities/llm-provider.entity';
import { MessageRole } from '../../../entities/message.entity';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { AuditAction, AuditResource } from '../../../entities/audit-log.entity';

/**
 * Consolidation engine. Spec §10 step 15 + §7.6.
 *
 * Background process that scans short-tier memory rows in a scope,
 * asks an LLM to extract durable facts from them, writes those facts
 * as long-tier rows with `confidence < 1` and `created_by = consolidation`,
 * then supersedes the source short-tier rows so subsequent searches
 * see the distilled output instead of the raw episodes.
 *
 * The cadence + threshold are per-workspace (workspace_config
 * `overrides.consolidation`):
 *
 *   - enabled (default false): is consolidation on for this scope at all
 *   - min_short_count (default 20): wait for at least N short rows
 *     to accumulate before running, so the LLM has enough material
 *   - older_than_minutes (default 60): only consolidate short rows
 *     older than this — give the agent time to refer back to recent
 *     ones before they get bundled away
 *   - model: optional model override (defaults to the provider's)
 */
export interface ConsolidationResult {
  scope: ScopeRef;
  scanned: number;
  consolidated_facts: number;
  superseded: number;
  skipped: boolean;
  reason?: string;
}

interface ConsolidationConfig {
  enabled: boolean;
  min_short_count: number;
  older_than_minutes: number;
  model?: string;
}

const DEFAULT_CONSOLIDATION: ConsolidationConfig = {
  enabled: false,
  min_short_count: 20,
  older_than_minutes: 60,
};

@Injectable()
export class ConsolidationService {
  private readonly logger = new Logger(ConsolidationService.name);

  constructor(
    @InjectRepository(CanonicalMemory)
    private readonly repo: Repository<CanonicalMemory>,
    @InjectRepository(LlmProvider)
    private readonly providerRepo: Repository<LlmProvider>,
    private readonly memoryService: CanonicalMemoryService,
    private readonly llm: LlmProvidersService,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * Run consolidation for one scope. Idempotent — if there's
   * nothing eligible (config disabled, too few rows, no LLM provider),
   * returns `skipped:true` with a reason instead of throwing.
   */
  async run(scope: ScopeRef, options: { force?: boolean } = {}): Promise<ConsolidationResult> {
    const config = await this.resolveConfig(scope);
    if (!config.enabled && !options.force) {
      return { scope, scanned: 0, consolidated_facts: 0, superseded: 0, skipped: true, reason: 'consolidation disabled for this scope' };
    }

    const cutoff = new Date(Date.now() - config.older_than_minutes * 60 * 1000);
    const shortRows = await this.repo.find({
      where: {
        scopeType: scope.scope_type,
        scopeId: scope.scope_id,
        mode: 'memory',
        tier: 'short',
        validUntil: IsNull(),
        deletedAt: IsNull(),
        createdAt: LessThan(cutoff),
      },
      order: { createdAt: 'ASC' },
      take: 200, // hard cap so a runaway scope doesn't melt the LLM
    });

    if (shortRows.length < config.min_short_count && !options.force) {
      return {
        scope, scanned: shortRows.length, consolidated_facts: 0, superseded: 0,
        skipped: true,
        reason: `${shortRows.length} short-tier rows < min_short_count=${config.min_short_count}`,
      };
    }

    const provider = await this.providerRepo.findOne({
      where: {
        organizationId: scope.scope_id,
        status: LlmProviderStatus.ACTIVE,
      },
      order: { createdAt: 'ASC' },
    });
    if (!provider) {
      return {
        scope, scanned: shortRows.length, consolidated_facts: 0, superseded: 0,
        skipped: true, reason: 'no active LLM provider for this scope',
      };
    }

    const sourceTexts = shortRows.map((r, i) => `(${i + 1}) ${r.content}`).join('\n');
    const prompt = buildConsolidationPrompt(sourceTexts);
    const request: ChatRequest = {
      model: config.model,
      temperature: 0.1,
      maxTokens: 2048,
      messages: [
        { role: MessageRole.SYSTEM, content: prompt.system },
        { role: MessageRole.USER, content: prompt.user },
      ],
    };

    const response = await this.llm.chat(provider.id, request, scope.scope_id);
    const facts = parseFacts(response.message?.content ?? '');

    if (facts.length === 0) {
      return {
        scope, scanned: shortRows.length, consolidated_facts: 0, superseded: 0,
        skipped: true, reason: 'LLM extracted no facts',
      };
    }

    // Write each fact as a long-tier row with confidence < 1, then
    // close the source short-tier rows by supersession (chained
    // through every fact's id so the audit trail makes sense).
    const provenance: Provenance = {
      agent_id: null,
      session_id: null,
      collab_id: null,
      model: response.model ?? provider.id,
      provider: provider.type ?? null,
      tool_chain: ['consolidation'],
      created_by: 'consolidation',
      source_backend: 'almyty-native',
    };

    const writtenIds: string[] = [];
    for (const fact of facts) {
      const created = await this.memoryService.put(
        {
          mode: 'memory',
          scope,
          content: fact.content,
          tier: 'long',
          tags: ['consolidated', ...(fact.tags ?? [])],
          metadata: { source_short_count: shortRows.length },
          provenance,
          confidence: fact.confidence ?? 0.7,
        },
        { user_id: undefined },
      );
      writtenIds.push(created.id);
    }

    // Mark every source short row as superseded by the FIRST
    // consolidated fact (most representative). One UPDATE keeps it
    // atomic.
    const supersededBy = writtenIds[0];
    const now = new Date();
    await this.repo
      .createQueryBuilder()
      .update(CanonicalMemory)
      .set({ validUntil: now, supersededBy, updatedAt: now })
      .whereInIds(shortRows.map((r) => r.id))
      .execute();

    this.auditLog.log({
      organizationId: scope.scope_id,
      action: AuditAction.MEMORY_SUPERSEDE,
      resourceType: AuditResource.MEMORY,
      resourceId: supersededBy,
      details: {
        op: 'consolidation',
        scope_type: scope.scope_type,
        scope_id: scope.scope_id,
        scanned: shortRows.length,
        facts_written: facts.length,
        fact_ids: writtenIds,
      },
    });

    return {
      scope, scanned: shortRows.length, consolidated_facts: facts.length,
      superseded: shortRows.length, skipped: false,
    };
  }

  /**
   * Run consolidation across every workspace scope that has it
   * enabled. Called by the scheduled BullMQ processor.
   */
  async runAllEnabled(): Promise<ConsolidationResult[]> {
    // Find every workspace_config with overrides.consolidation.enabled = true.
    // We don't paginate because the row count is naturally bounded
    // by the workspace count, not the memory count.
    const cfgs = await this.repo.manager.query(
      `
      SELECT scope_type, scope_id
      FROM memory_workspace_config
      WHERE overrides ? 'consolidation'
        AND overrides->'consolidation'->>'enabled' = 'true'
      `,
    );
    const out: ConsolidationResult[] = [];
    for (const r of cfgs as Array<{ scope_type: string; scope_id: string }>) {
      try {
        out.push(await this.run({ scope_type: r.scope_type as any, scope_id: r.scope_id }));
      } catch (e: any) {
        this.logger.error(`consolidation failed for ${r.scope_type}:${r.scope_id}: ${e.message}`);
        out.push({
          scope: { scope_type: r.scope_type as any, scope_id: r.scope_id },
          scanned: 0, consolidated_facts: 0, superseded: 0,
          skipped: true, reason: `error: ${e.message}`,
        });
      }
    }
    return out;
  }

  // ────────────────────────────────────────────────────────────

  private async resolveConfig(scope: ScopeRef): Promise<ConsolidationConfig> {
    const cfg = await this.memoryService.getOrCreateConfig(scope.scope_type, scope.scope_id);
    const overrides = (cfg.overrides as any) ?? {};
    const block = (overrides.consolidation ?? {}) as Partial<ConsolidationConfig>;
    return { ...DEFAULT_CONSOLIDATION, ...block };
  }
}

// ────────────────────────────────────────────────────────────────
// Prompt + parser

function buildConsolidationPrompt(sources: string): { system: string; user: string } {
  return {
    system: [
      'You consolidate short-term agent memories into durable, long-term facts.',
      'Read the numbered episodes below and extract every fact that is likely',
      'to remain true beyond this session — preferences, decisions, identifiers,',
      'irreversible state changes. Drop chitchat, transient state, and exact',
      'phrasing of one-off requests.',
      '',
      'Output strict JSON only:',
      '{ "facts": [ { "content": "...", "tags": ["..."], "confidence": 0.7 }, ... ] }',
      '',
      'confidence is in [0,1]. Use 0.9 for facts you are certain of, 0.6 for plausible inferences,',
      'lower for guesses. Output an empty array if there are no durable facts.',
    ].join('\n'),
    user: `Episodes:\n${sources}`,
  };
}

function parseFacts(raw: string): Array<{ content: string; tags?: string[]; confidence?: number }> {
  if (!raw) return [];
  // Strip code fences if present.
  const cleaned = raw.replace(/^```(?:json)?\s*/im, '').replace(/```\s*$/m, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    const arr = Array.isArray(parsed?.facts) ? parsed.facts : Array.isArray(parsed) ? parsed : [];
    const out: Array<{ content: string; tags?: string[]; confidence?: number }> = [];
    for (const f of arr) {
      if (!f || typeof f.content !== 'string' || f.content.trim().length === 0) continue;
      out.push({
        content: String(f.content).trim(),
        tags: Array.isArray(f.tags) ? f.tags.filter((t: unknown): t is string => typeof t === 'string') : undefined,
        confidence: typeof f.confidence === 'number' && f.confidence >= 0 && f.confidence <= 1
          ? f.confidence : undefined,
      });
    }
    return out;
  } catch {
    return [];
  }
}

// Exposed for tests.
export const __test__ = { buildConsolidationPrompt, parseFacts };
