import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EmbeddingService } from '../embedding.service';
import { LlmProvider } from '../../../entities/llm-provider.entity';

describe('EmbeddingService', () => {
  let service: EmbeddingService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmbeddingService,
        {
          provide: getRepositoryToken(LlmProvider),
          useValue: {
            findOne: jest.fn().mockResolvedValue(null),
          },
        },
      ],
    }).compile();

    service = module.get<EmbeddingService>(EmbeddingService);
  });

  // ── generateEmbedding ─────────────────────────────────────────────────

  describe('generateEmbedding', () => {
    it('returns the canonical embedding dimension (matches the pgvector column width)', async () => {
      // Bumped from 256 -> LIMITS.EMBEDDING_DEFAULT_DIM (1536). The
      // canonical_memories.embedding column is vector(1536) and when
      // the fallback emitted 256-dim while OpenAI emitted 1536-dim,
      // any subsequent hybrid search crashed with
      //   QueryFailedError: different vector dimensions 1536 and 256
      // Both code paths now produce the same width so writes + reads
      // always match the column.
      const embedding = await service.generateEmbedding('Hello world');

      expect(embedding).toBeDefined();
      expect(Array.isArray(embedding)).toBe(true);
      expect(embedding).toHaveLength(1536);
      embedding!.forEach(v => expect(typeof v).toBe('number'));
    });

    it('should return deterministic results for the same input', async () => {
      const a = await service.generateEmbedding('Same text');
      const b = await service.generateEmbedding('Same text');

      expect(a).toEqual(b);
    });

    it('should return different embeddings for different inputs', async () => {
      const a = await service.generateEmbedding('apples and oranges');
      const b = await service.generateEmbedding('quantum computing research');

      expect(a).not.toEqual(b);
    });
  });

  // ── cosineSimilarity ──────────────────────────────────────────────────

  describe('cosineSimilarity', () => {
    it('should return 1 for identical vectors', () => {
      const vec = [0.5, 0.5, 0.5, 0.5];
      const similarity = service.cosineSimilarity(vec, vec);
      expect(similarity).toBeCloseTo(1.0, 5);
    });

    it('should return 0 for orthogonal vectors', () => {
      const a = [1, 0, 0];
      const b = [0, 1, 0];
      const similarity = service.cosineSimilarity(a, b);
      expect(similarity).toBeCloseTo(0.0, 5);
    });

    it('should return 0 for null or mismatched vectors', () => {
      expect(service.cosineSimilarity(null as any, [1, 2])).toBe(0);
      expect(service.cosineSimilarity([1, 2], null as any)).toBe(0);
      expect(service.cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    });

    it('should return 0 for zero vectors', () => {
      expect(service.cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    });
  });

  // ── semantic similarity ───────────────────────────────────────────────

  describe('semantic similarity', () => {
    it('should produce higher similarity for similar text than different text', async () => {
      const base = await service.generateEmbedding('machine learning algorithms');
      const similar = await service.generateEmbedding('deep learning models');
      const different = await service.generateEmbedding('cooking recipe for pasta');

      const simSimilar = service.cosineSimilarity(base!, similar!);
      const simDifferent = service.cosineSimilarity(base!, different!);

      expect(simSimilar).toBeGreaterThan(simDifferent);
    });
  });
});
