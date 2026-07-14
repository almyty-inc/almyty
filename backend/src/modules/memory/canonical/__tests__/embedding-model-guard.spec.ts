import { DataSource } from 'typeorm';

import { CanonicalMemoryService } from '../canonical-memory.service';
import { CanonicalSearchHelper } from '../canonical-search.helper';
import { CanonicalMemoryOpsHelper } from '../canonical-ops.helper';
import { EmbeddingService, EmbeddingResult } from '../../embedding.service';
import { LIMITS } from '../canonical.constants';
import { RankedItem, SearchQuery } from '../canonical.types';

/**
 * Mixed-embedding-model safety.
 *
 * Vectors produced by different models (text-embedding-3-small: 1536-dim,
 * mistral-embed: 1024-dim, hash fallback) live in different embedding
 * spaces. These tests pin the guard rails:
 *  - writes record the ACTUAL model + raw dim on the row,
 *  - the vector half of hybrid search only compares rows whose
 *    embedding_model matches the query embedding's model,
 *  - when nothing is vector-comparable the service falls back to FTS
 *    instead of silently comparing incompatible vectors.
 */

const scope = { scope_type: 'workspace' as const, scope_id: 'org-1:wks-1' };

function mistralResult(dim = 1024): EmbeddingResult {
  return {
    vector: new Array(dim).fill(0).map((_, i) => (i % 5) / 5),
    model: 'mistral-embed',
    dim,
    provider: 'mistral',
  };
}

function ranked(id: string, signal: 'hybrid' | 'fts'): RankedItem {
  return { item: { id } as any, score: 0.9, signal };
}

describe('CanonicalSearchHelper like-with-like guard', () => {
  it('filters the vector CTE on the query embedding model', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const helper = new CanonicalSearchHelper({ query } as unknown as DataSource);

    const vec = new Array(LIMITS.EMBEDDING_DEFAULT_DIM).fill(0.1);
    await helper.hybridSearch({ scope, query: 'find me' } as SearchQuery, vec, 5, 'mistral-embed');

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('m.embedding_model = $6');
    expect(params[5]).toBe('mistral-embed');
  });

  it('keeps the model filter compatible with the optional mode/tier/tags params', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const helper = new CanonicalSearchHelper({ query } as unknown as DataSource);

    const vec = new Array(LIMITS.EMBEDDING_DEFAULT_DIM).fill(0.1);
    await helper.hybridSearch(
      { scope, query: 'q', mode: 'memory', tier: 'short', tags: ['a'] } as SearchQuery,
      vec,
      5,
      'text-embedding-3-small',
    );

    const [sql, params] = query.mock.calls[0];
    expect(params[5]).toBe('text-embedding-3-small');
    // Optional filters land after the fixed six params.
    expect(sql).toContain('m.mode = $7');
    expect(sql).toContain('m.tier = $8');
    expect(sql).toContain('m.tags && $9');
    expect(params).toHaveLength(9);
  });
});

describe('CanonicalMemoryService.search cross-model behavior', () => {
  function buildService(overrides: {
    embedding: Partial<EmbeddingService>;
    hybrid: jest.Mock;
    fts: jest.Mock;
    auditLog?: { log: jest.Mock };
  }) {
    const repo = {
      createQueryBuilder: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        whereInIds: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue(undefined),
      }),
    };
    const auditLog = overrides.auditLog ?? { log: jest.fn() };
    const service = new CanonicalMemoryService(
      repo as any,
      {} as any, // configRepo
      {} as any, // warningRepo
      {} as any, // embeddingQueue
      {} as any, // dataSource
      auditLog as any,
      overrides.embedding as any,
      { hybridSearch: overrides.hybrid, ftsSearch: overrides.fts } as any,
      {} as any, // opsHelper
      {} as any, // putValidators
    );
    return { service, auditLog };
  }

  it('pads the query vector to the column width and passes the query model to hybrid search', async () => {
    const hybrid = jest.fn().mockResolvedValue([ranked('m1', 'hybrid')]);
    const fts = jest.fn();
    const { service } = buildService({
      embedding: { generateEmbedding: jest.fn().mockResolvedValue(mistralResult()) },
      hybrid,
      fts,
    });

    const results = await service.search({ scope, query: 'hello' } as SearchQuery);

    expect(hybrid).toHaveBeenCalledTimes(1);
    const [, vector, , model] = hybrid.mock.calls[0];
    // 1024-dim mistral query vector is zero-padded to vector(1536) so
    // pgvector's <=> does not error on dimension mismatch.
    expect(vector).toHaveLength(LIMITS.EMBEDDING_DEFAULT_DIM);
    expect(vector.slice(1024).every((v: number) => v === 0)).toBe(true);
    expect(model).toBe('mistral-embed');
    expect(fts).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
  });

  it('falls back to FTS when no row is vector-comparable with the query model', async () => {
    // Org switched to Mistral but existing rows were embedded with
    // openai/hash: the like-with-like guard excludes them from the
    // vector half, so the service must fall back to lexical search
    // rather than compare incompatible vectors (or return nothing).
    const hybrid = jest.fn().mockResolvedValue([]);
    const fts = jest.fn().mockResolvedValue([ranked('m2', 'fts')]);
    const auditLog = { log: jest.fn() };
    const { service } = buildService({
      embedding: { generateEmbedding: jest.fn().mockResolvedValue(mistralResult()) },
      hybrid,
      fts,
      auditLog,
    });

    const results = await service.search({ scope, query: 'legacy memory' } as SearchQuery);

    expect(hybrid).toHaveBeenCalledTimes(1);
    expect(fts).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.item.id)).toEqual(['m2']);
    expect(auditLog.log).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ signal: 'fts' }) }),
    );
  });

  it('uses FTS only when the query cannot be embedded', async () => {
    const hybrid = jest.fn();
    const fts = jest.fn().mockResolvedValue([]);
    const { service } = buildService({
      embedding: { generateEmbedding: jest.fn().mockResolvedValue(null) },
      hybrid,
      fts,
    });

    await service.search({ scope, query: 'q' } as SearchQuery);

    expect(hybrid).not.toHaveBeenCalled();
    expect(fts).toHaveBeenCalledTimes(1);
  });
});

describe('CanonicalMemoryOpsHelper.fillEmbedding model/dim recording', () => {
  function buildHelper(embeddingResult: EmbeddingResult | null) {
    const row = {
      id: 'mem-1',
      scopeType: 'workspace',
      scopeId: 'org-1:wks-1',
      content: 'remember this',
      embeddingStatus: 'pending',
    };
    const repo = {
      findOne: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const configRepo = {
      findOne: jest.fn().mockResolvedValue({
        embeddingModel: LIMITS.EMBEDDING_DEFAULT_MODEL,
        embeddingDim: LIMITS.EMBEDDING_DEFAULT_DIM,
      }),
      create: jest.fn(),
      save: jest.fn(),
    };
    const helper = new CanonicalMemoryOpsHelper(
      repo as any,
      configRepo as any,
      {} as any, // warningRepo
      { add: jest.fn() } as any, // embeddingQueue
      { log: jest.fn() } as any, // auditLog
      { generateEmbedding: jest.fn().mockResolvedValue(embeddingResult) } as any,
      {} as any, // service
    );
    return { helper, repo };
  }

  it('records the ACTUAL embedding model and raw dim, padding the stored vector to the column width', async () => {
    const { helper, repo } = buildHelper(mistralResult(1024));

    await helper.fillEmbedding('mem-1');

    expect(repo.update).toHaveBeenCalledTimes(1);
    const [, patch] = repo.update.mock.calls[0];
    expect(patch.embeddingModel).toBe('mistral-embed');
    expect(patch.embeddingDim).toBe(1024);
    expect(patch.embedding).toHaveLength(LIMITS.EMBEDDING_DEFAULT_DIM);
    // Zero padding, which preserves cosine similarity between vectors
    // padded from the same raw dimensionality.
    expect(patch.embedding.slice(1024).every((v: number) => v === 0)).toBe(true);
    expect(patch.embeddingStatus).toBe('ready');
  });

  it('marks the row failed when embedding generation returns null', async () => {
    const { helper, repo } = buildHelper(null);

    await helper.fillEmbedding('mem-1');

    const [, patch] = repo.update.mock.calls[0];
    expect(patch.embeddingStatus).toBe('failed');
  });
});
