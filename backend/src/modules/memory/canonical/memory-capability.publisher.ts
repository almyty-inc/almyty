import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Tool, ToolStatus, ToolType } from '../../../entities/tool.entity';
import { ScopeType } from './canonical.types';

interface MemoryCapabilityDef {
  method: 'store' | 'recall' | 'list' | 'search';
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Mirrors RunnerCapabilityPublisher — mints Tool rows for the memory
 * subsystem so any agent / MCP gateway / OpenAI-compat surface can call
 * memory operations via the standard tool dispatch path. Tools are
 * scoped to (organizationId, optionally teamId), and inherit a memory
 * scope ({scope_type, scope_id}) that's stamped into every memory row
 * the tool writes.
 *
 * Naming: `memory.<scope_label>.<method>`. Examples:
 *   memory.org.store
 *   memory.team-eng.recall
 *
 * v1.0 surface: store / recall / list / search. supersede / transfer /
 * consolidate are left as platform admin operations (org-only) and
 * stay unpublished — they don't fit the per-call agent flow.
 */
@Injectable()
export class MemoryCapabilityPublisher {
  private readonly logger = new Logger(MemoryCapabilityPublisher.name);

  private static readonly CAPABILITIES: MemoryCapabilityDef[] = [
    {
      method: 'store',
      description: 'Store a memory item in long-term storage. Use to save important facts, decisions, preferences, or context for future recall. Returns the canonical memory id.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The text content to store.' },
          tier: { type: 'string', enum: ['short', 'project', 'long', 'shared'], description: 'Retention tier.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional labels for filtering on recall.' },
          mode: { type: 'string', enum: ['memory', 'document'], description: 'Memory items are individual facts; documents get chunked and indexed.' },
          confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Confidence in this memory (default 1.0).' },
          ttl_seconds: { type: 'integer', minimum: 1, description: 'Optional time-to-live; memory expires after this many seconds.' },
        },
        required: ['content'],
        additionalProperties: false,
      },
    },
    {
      method: 'recall',
      description: 'Semantic search over stored memories. Returns the top matches by vector similarity. Use to retrieve previously stored context relevant to a topic.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The query text. Will be embedded and matched against stored memories.' },
          top_k: { type: 'integer', minimum: 1, maximum: 100, description: 'Max results (default 10).' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Restrict results to memories with these tags.' },
          tier: { type: 'string', enum: ['short', 'project', 'long', 'shared'] },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    {
      method: 'list',
      description: 'List recent memories in this scope. Paginated. Use to enumerate stored items without semantic search.',
      parameters: {
        type: 'object',
        properties: {
          tier: { type: 'string', enum: ['short', 'project', 'long', 'shared'] },
          tags: { type: 'array', items: { type: 'string' } },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
          cursor: { type: ['string', 'null'] },
        },
        additionalProperties: false,
      },
    },
    {
      method: 'search',
      description: 'Full-text search over stored memories (no embedding). Use when you want exact-keyword matching rather than semantic similarity.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          top_k: { type: 'integer', minimum: 1, maximum: 100 },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  ];

  constructor(
    @InjectRepository(Tool)
    private readonly tools: Repository<Tool>,
  ) {}

  /**
   * Mint Tool rows for every memory capability in this scope. Idempotent
   * — re-publishing the same scope deletes prior rows in one transaction
   * and inserts fresh ones (matches RunnerCapabilityPublisher).
   *
   * scope.scope_id encodes who owns the memories (typically the org id
   * for org-wide memory or a team id for team-scoped memory). The
   * organizationId column on the Tool row is always the org; teamId is
   * set when the scope is team-bound so AccessPolicyService.applyListFilter
   * keeps the tool inside the team.
   */
  async publish(args: {
    organizationId: string;
    teamId: string | null;
    scope: { scope_type: ScopeType; scope_id: string };
    scopeLabel: string;
    mode?: 'memory' | 'document';
  }): Promise<Tool[]> {
    return this.tools.manager.transaction(async (mgr) => {
      const repo = mgr.getRepository(Tool);
      const visibility = args.teamId ? 'team' : 'org';
      // Drop prior rows for this exact scope. Indexed on the partial
      // (memoryConfig is not null) + the scope_id JSON path.
      await repo
        .createQueryBuilder()
        .delete()
        .from(Tool)
        .where(`"memoryConfig"->'scope'->>'scope_id' = :scopeId`, { scopeId: args.scope.scope_id })
        .andWhere(`"memoryConfig"->'scope'->>'scope_type' = :scopeType`, { scopeType: args.scope.scope_type })
        .andWhere('"organizationId" = :orgId', { orgId: args.organizationId })
        .execute();

      const rows: Tool[] = [];
      for (const cap of MemoryCapabilityPublisher.CAPABILITIES) {
        const row = repo.create({
          name: `memory.${args.scopeLabel}.${cap.method}`,
          description: cap.description,
          type: ToolType.FUNCTION,
          status: ToolStatus.ACTIVE,
          version: '1.0.0',
          organizationId: args.organizationId,
          teamId: args.teamId,
          visibility,
          parameters: cap.parameters,
          memoryConfig: {
            method: cap.method,
            scope: args.scope,
            mode: args.mode ?? 'memory',
          },
          metadata: {
            source: `memory:${args.scopeLabel}`,
          },
        } as Partial<Tool>);
        rows.push(await repo.save(row));
      }
      this.logger.log(
        `published ${rows.length} memory capabilities for scope ${args.scope.scope_type}:${args.scope.scope_id} ` +
        `(org=${args.organizationId}, team=${args.teamId ?? '—'})`,
      );
      return rows;
    });
  }

  /**
   * Drop every memory-backed Tool row for an exact scope. Called on
   * memory backend disable.
   */
  async unpublish(args: {
    organizationId: string;
    scope: { scope_type: ScopeType; scope_id: string };
  }): Promise<number> {
    const result = await this.tools
      .createQueryBuilder()
      .delete()
      .from(Tool)
      .where(`"memoryConfig"->'scope'->>'scope_id' = :scopeId`, { scopeId: args.scope.scope_id })
      .andWhere(`"memoryConfig"->'scope'->>'scope_type' = :scopeType`, { scopeType: args.scope.scope_type })
      .andWhere('"organizationId" = :orgId', { orgId: args.organizationId })
      .execute();
    const affected = result.affected ?? 0;
    if (affected > 0) {
      this.logger.log(
        `unpublished ${affected} memory capabilities for scope ${args.scope.scope_type}:${args.scope.scope_id}`,
      );
    }
    return affected;
  }

  async listForScope(args: { organizationId: string; scope: { scope_type: ScopeType; scope_id: string } }): Promise<Tool[]> {
    return this.tools
      .createQueryBuilder('t')
      .where(`t."memoryConfig"->'scope'->>'scope_id' = :scopeId`, { scopeId: args.scope.scope_id })
      .andWhere(`t."memoryConfig"->'scope'->>'scope_type' = :scopeType`, { scopeType: args.scope.scope_type })
      .andWhere('t."organizationId" = :orgId', { orgId: args.organizationId })
      .getMany();
  }
}
