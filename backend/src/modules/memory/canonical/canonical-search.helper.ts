import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as pgvector from 'pgvector';

import { CanonicalMemory } from './canonical-memory.entity';
import { MemoryItem, RankedItem, SearchQuery } from './canonical.types';
import { entityToItem, rowToEntity } from './canonical-memory.service';

@Injectable()
export class CanonicalSearchHelper {
  private readonly logger = new Logger(CanonicalSearchHelper.name);

  constructor(private readonly dataSource: DataSource) {}

  async hybridSearch(
    query: SearchQuery,
    queryEmbedding: number[],
    topK: number,
  ): Promise<RankedItem[]> {
    // Hybrid scoring: vector cosine distance ascending + FTS rank
    // descending, normalized into a single weighted score. The
    // candidate pool is bounded by the index — pgvector's HNSW gives
    // us O(log n) nearest-neighbour lookup, and FTS rides the GIN
    // index on `content_tsv`.
    const params: any[] = [
      query.scope.scope_type,
      query.scope.scope_id,
      pgvector.toSql(queryEmbedding),
      query.query,
      topK,
    ];
    let where = `m.scope_type = $1 AND m.scope_id = $2 AND m.deleted_at IS NULL AND m.valid_until IS NULL AND m.embedding IS NOT NULL`;
    if (query.mode) {
      params.push(query.mode);
      where += ` AND m.mode = $${params.length}`;
    }
    if (query.tier) {
      params.push(query.tier);
      where += ` AND m.tier = $${params.length}`;
    }
    if (query.tags && query.tags.length > 0) {
      params.push(query.tags);
      where += ` AND m.tags && $${params.length}`;
    }

    const rows = await this.dataSource.query(
      `
      WITH vec AS (
        SELECT m.*, (m.embedding <=> $3::vector) AS vec_distance
        FROM memories m
        WHERE ${where}
        ORDER BY m.embedding <=> $3::vector
        LIMIT $5 * 4
      ),
      fts AS (
        SELECT m.id, ts_rank_cd(m.content_tsv, plainto_tsquery('english', $4)) AS fts_rank
        FROM memories m
        WHERE m.scope_type = $1 AND m.scope_id = $2
          AND m.deleted_at IS NULL AND m.valid_until IS NULL
          AND m.content_tsv @@ plainto_tsquery('english', $4)
        ORDER BY fts_rank DESC
        LIMIT $5 * 4
      )
      SELECT v.*,
             COALESCE(f.fts_rank, 0) AS fts_rank,
             v.vec_distance
      FROM vec v
      LEFT JOIN fts f ON f.id = v.id
      ORDER BY (1 - v.vec_distance) * 0.7 + COALESCE(f.fts_rank, 0) * 0.3 DESC
      LIMIT $5
      `,
      params,
    );

    return rows.map((row: any) => ({
      item: entityToItem(rowToEntity(row)),
      score: (1 - Number(row.vec_distance)) * 0.7 + Number(row.fts_rank ?? 0) * 0.3,
      signal: 'hybrid' as const,
    }));
  }

  async ftsSearch(query: SearchQuery, topK: number): Promise<RankedItem[]> {
    const params: any[] = [query.scope.scope_type, query.scope.scope_id, query.query, topK];
    let where = `m.scope_type = $1 AND m.scope_id = $2 AND m.deleted_at IS NULL AND m.valid_until IS NULL AND m.content_tsv @@ plainto_tsquery('english', $3)`;
    if (query.mode) {
      params.push(query.mode);
      where += ` AND m.mode = $${params.length}`;
    }

    const rows = await this.dataSource.query(
      `
      SELECT m.*, ts_rank_cd(m.content_tsv, plainto_tsquery('english', $3)) AS fts_rank
      FROM memories m
      WHERE ${where}
      ORDER BY fts_rank DESC
      LIMIT $4
      `,
      params,
    );
    return rows.map((row: any) => ({
      item: entityToItem(rowToEntity(row)),
      score: Number(row.fts_rank ?? 0),
      signal: 'fts' as const,
    }));
  }

  // ────────────────────────────────────────────────────────────────────
  // As-of queries: fetch the row that was current at `time`.
  // ────────────────────────────────────────────────────────────────────

}
