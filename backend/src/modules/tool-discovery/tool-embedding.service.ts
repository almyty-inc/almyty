import { Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { InjectDataSource } from '@nestjs/typeorm';
import { Queue } from 'bull';
import { createHash } from 'crypto';
import { DataSource, EntitySubscriberInterface, InsertEvent, UpdateEvent } from 'typeorm';

import { Tool, ToolStatus } from '../../entities/tool.entity';
import { EmbeddingService } from '../memory/embedding.service';
import { LIMITS } from '../memory/canonical/canonical.constants';
import { SearchableTool, searchText } from './tool-search';
import { toolDiscoverySettings } from './tool-discovery.settings';

export const TOOL_EMBEDDING_QUEUE = 'tool-embeddings';

/** The columns a tool's searchable text is made from; an update touching none of them is not re-embedded. */
const TEXT_COLUMNS = new Set(['name', 'description', 'parameters', 'metadata', 'status', 'operationId', 'apiId']);

/** The text a tool's embedding is computed from. */
export function embeddingText(tool: SearchableTool): string {
  const t = searchText(tool);
  return [t.name, t.identifiers, t.tags, t.description, t.params].filter(Boolean).join('\n').slice(0, 8_000);
}

export function textHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Tool embeddings for search_tools (docs/design/code-mode.md, part B).
 *
 * Every tool written (created, edited, re-imported) queues a job; the job
 * embeds the tool's searchable text with the organization's embedding
 * provider (EmbeddingService: OpenAI, Mistral or Ollama, else the hash
 * fallback) and stores it with its model. A tool whose text did not change
 * is not embedded again. At boot, tools with no embedding yet are queued.
 *
 * A search embeds the query the same way and ranks the candidates by
 * cosine distance, comparing only vectors of the query's model.
 */
@Injectable()
export class ToolEmbeddingService implements EntitySubscriberInterface<Tool>, OnApplicationBootstrap {
  private readonly logger = new Logger(ToolEmbeddingService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly embeddings: EmbeddingService,
    @Optional() @InjectQueue(TOOL_EMBEDDING_QUEUE) private readonly queue?: Queue,
  ) {
    // An entity subscriber sees every insert and save of a tool, whichever
    // service made it, so no write path can be left out.
    this.dataSource.subscribers.push(this);
  }

  listenTo() {
    return Tool;
  }

  afterInsert(event: InsertEvent<Tool>): void {
    if (event.entity?.id) this.enqueue(event.entity.id);
  }

  afterUpdate(event: UpdateEvent<Tool>): void {
    const id = (event.entity as Tool | undefined)?.id ?? (event.databaseEntity as Tool | undefined)?.id;
    if (!id) return;
    const touched = event.updatedColumns?.map((c) => c.propertyName) ?? [];
    if (touched.length && !touched.some((c) => TEXT_COLUMNS.has(c))) return;
    this.enqueue(id);
  }

  /**
   * Queue a tool's embedding. Fire and forget: a queue that is down never
   * fails the tool's write. A fixed `jobId` collapses repeats while one is
   * waiting (the heal path in nearest()); without one, every change queues.
   */
  enqueue(toolId: string, jobId: string = `tool-embed:${toolId}:${Date.now()}`): void {
    if (!this.queue || !toolDiscoverySettings().embeddingsEnabled) return;
    this.queue
      .add('embed', { toolId }, { jobId, attempts: 3, backoff: { type: 'exponential', delay: 2_000 }, removeOnComplete: true, removeOnFail: 100 })
      .catch((err) => this.logger.warn(`Could not queue the embedding of tool ${toolId}: ${err?.message ?? err}`));
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.queue || !toolDiscoverySettings().embeddingsEnabled) return;
    await this.queue
      .add('backfill', {}, { jobId: 'tool-embed-backfill', removeOnComplete: true, removeOnFail: 10 })
      .catch((err) => this.logger.warn(`Could not queue the tool embedding backfill: ${err?.message ?? err}`));
  }

  /** Queue every live tool that has no embedding yet, a page at a time. */
  async backfill(batch = 500): Promise<number> {
    let queued = 0;
    let after = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      const rows: Array<{ id: string }> = await this.dataSource.query(
        `SELECT t."id" FROM "tools" t
          WHERE t."status" <> $1 AND t."id" > $2
            AND NOT EXISTS (SELECT 1 FROM "tool_embeddings" e WHERE e."toolId" = t."id")
          ORDER BY t."id"
          LIMIT $3`,
        [ToolStatus.DELETED, after, batch],
      );
      for (const row of rows) this.enqueue(row.id);
      queued += rows.length;
      if (rows.length < batch) return queued;
      after = rows[rows.length - 1].id;
    }
  }

  /** Embed one tool, unless its text has not changed since its stored embedding. */
  async embedTool(toolId: string): Promise<'embedded' | 'unchanged' | 'removed' | 'missing'> {
    const tool = await this.dataSource.getRepository(Tool).findOne({ where: { id: toolId }, relations: { operation: true, api: true } });
    if (!tool) return 'missing';
    if (tool.status === ToolStatus.DELETED) {
      await this.dataSource.query(`DELETE FROM "tool_embeddings" WHERE "toolId" = $1`, [toolId]);
      return 'removed';
    }
    const text = embeddingText(tool);
    const hash = textHash(text);
    const result = await this.embeddings.generateEmbedding(text, tool.organizationId);
    if (!result) return 'missing';
    const existing: Array<{ textHash: string }> = await this.dataSource.query(
      `SELECT "textHash" FROM "tool_embeddings" WHERE "toolId" = $1 AND "model" = $2`,
      [toolId, result.model],
    );
    if (existing[0]?.textHash === hash) return 'unchanged';
    const vector = EmbeddingService.padToDim(result.vector, LIMITS.EMBEDDING_DEFAULT_DIM);
    await this.dataSource.query(
      `INSERT INTO "tool_embeddings" ("toolId", "organizationId", "model", "dim", "embedding", "textHash", "updatedAt")
       VALUES ($1, $2, $3, $4, $5::vector, $6, now())
       ON CONFLICT ("toolId", "model") DO UPDATE
         SET "embedding" = EXCLUDED."embedding", "dim" = EXCLUDED."dim", "textHash" = EXCLUDED."textHash", "updatedAt" = now()`,
      [toolId, tool.organizationId, result.model, result.dim, `[${vector.join(',')}]`, hash],
    );
    return 'embedded';
  }

  /**
   * The candidate tools nearest to the query, nearest first. Only vectors of
   * the model the query was embedded with are compared; a tool without one
   * (not embedded yet, or embedded with another model) is simply absent.
   */
  async nearest(organizationId: string, toolIds: string[], query: string, topK: number): Promise<{ ids: string[]; model: string | null }> {
    if (!toolIds.length || !toolDiscoverySettings().embeddingsEnabled) return { ids: [], model: null };
    const result = await this.embeddings.generateEmbedding(query, organizationId);
    if (!result) return { ids: [], model: null };
    const vector = EmbeddingService.padToDim(result.vector, LIMITS.EMBEDDING_DEFAULT_DIM);
    const rows: Array<{ toolId: string }> = await this.dataSource.query(
      `SELECT "toolId" FROM "tool_embeddings"
        WHERE "organizationId" = $1 AND "model" = $2 AND "toolId" = ANY($3::uuid[])
        ORDER BY "embedding" <=> $4::vector
        LIMIT $5`,
      [organizationId, result.model, toolIds, `[${vector.join(',')}]`, topK],
    );
    // Candidates with no vector of this model (embedded before the
    // organization connected this provider, or not yet at all): queue them,
    // so the next search compares them too. One job per tool and model.
    if (rows.length < Math.min(toolIds.length, topK)) {
      const have: Array<{ toolId: string }> = await this.dataSource.query(
        `SELECT "toolId" FROM "tool_embeddings" WHERE "model" = $1 AND "toolId" = ANY($2::uuid[])`,
        [result.model, toolIds],
      );
      const embedded = new Set(have.map((r) => r.toolId));
      for (const id of toolIds) if (!embedded.has(id)) this.enqueue(id, `tool-embed:${id}:${result.model}`);
    }
    return { ids: rows.map((r) => r.toolId), model: result.model };
  }
}
