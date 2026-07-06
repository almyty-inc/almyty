import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import axios from 'axios';
import { EmbeddingService, HASH_EMBEDDING_MODEL } from '../embedding.service';
import { LlmProvider, LlmProviderType, LlmProviderStatus } from '../../../entities/llm-provider.entity';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

function fakeProvider(type: LlmProviderType, apiKey = 'test-key', apiUrl?: string): LlmProvider {
  return {
    id: `prov-${type}`,
    type,
    status: LlmProviderStatus.ACTIVE,
    configuration: { apiKey, ...(apiUrl ? { apiUrl } : {}) },
    getDecryptedApiKey: () => apiKey,
  } as unknown as LlmProvider;
}

function embeddingResponse(dim: number) {
  return {
    data: { data: [{ embedding: new Array(dim).fill(0).map((_, i) => (i % 7) / 7) }] },
  };
}

describe('EmbeddingService', () => {
  let service: EmbeddingService;
  let repoFind: jest.Mock;

  beforeEach(async () => {
    jest.clearAllMocks();
    repoFind = jest.fn().mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmbeddingService,
        {
          provide: getRepositoryToken(LlmProvider),
          useValue: { find: repoFind },
        },
      ],
    }).compile();

    service = module.get<EmbeddingService>(EmbeddingService);
  });

  // ── hash fallback ─────────────────────────────────────────────────────

  describe('hash fallback', () => {
    it('returns the canonical embedding dimension (matches the pgvector column width)', async () => {
      // The canonical_memories.embedding column is vector(1536); the
      // fallback must emit the same width so writes + reads always
      // match the column.
      const result = await service.generateEmbedding('Hello world');

      expect(result).toBeDefined();
      expect(result!.vector).toHaveLength(1536);
      expect(result!.dim).toBe(1536);
      expect(result!.model).toBe(HASH_EMBEDDING_MODEL);
      expect(result!.provider).toBe('hash');
      result!.vector.forEach(v => expect(typeof v).toBe('number'));
    });

    it('is used when the org has no embedding-capable provider', async () => {
      repoFind.mockResolvedValue([]);
      const result = await service.generateEmbedding('some text', 'org-1');

      expect(result!.model).toBe(HASH_EMBEDDING_MODEL);
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('returns deterministic results for the same input', async () => {
      const a = await service.generateEmbedding('Same text');
      const b = await service.generateEmbedding('Same text');

      expect(a).toEqual(b);
    });

    it('returns different embeddings for different inputs', async () => {
      const a = await service.generateEmbedding('apples and oranges');
      const b = await service.generateEmbedding('quantum computing research');

      expect(a).not.toEqual(b);
    });
  });

  // ── provider-aware dispatch ───────────────────────────────────────────

  describe('provider dispatch', () => {
    it('calls mistral-embed for an org whose only capable provider is Mistral', async () => {
      repoFind.mockResolvedValue([fakeProvider(LlmProviderType.MISTRAL, 'mistral-key')]);
      mockedAxios.post.mockResolvedValue(embeddingResponse(1024));

      const result = await service.generateEmbedding('bonjour le monde', 'org-mistral');

      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
      const [url, body, options] = mockedAxios.post.mock.calls[0];
      expect(url).toBe('https://api.mistral.ai/v1/embeddings');
      // Mistral requires `input` to be an array.
      expect(body).toEqual({ model: 'mistral-embed', input: ['bonjour le monde'] });
      expect((options as any).headers['Authorization']).toBe('Bearer mistral-key');

      expect(result!.model).toBe('mistral-embed');
      expect(result!.provider).toBe('mistral');
      expect(result!.dim).toBe(1024);
      expect(result!.vector).toHaveLength(1024);
    });

    it('prefers OpenAI when both OpenAI and Mistral providers are active', async () => {
      repoFind.mockResolvedValue([
        fakeProvider(LlmProviderType.MISTRAL, 'mistral-key'),
        fakeProvider(LlmProviderType.OPENAI, 'openai-key'),
      ]);
      mockedAxios.post.mockResolvedValue(embeddingResponse(1536));

      const result = await service.generateEmbedding('hello', 'org-both');

      const [url, body, options] = mockedAxios.post.mock.calls[0];
      expect(url).toBe('https://api.openai.com/v1/embeddings');
      expect(body).toEqual({ model: 'text-embedding-3-small', input: 'hello' });
      expect((options as any).headers['Authorization']).toBe('Bearer openai-key');

      expect(result!.model).toBe('text-embedding-3-small');
      expect(result!.provider).toBe('openai');
      expect(result!.dim).toBe(1536);
    });

    it('honors a custom apiUrl on the provider configuration', async () => {
      repoFind.mockResolvedValue([
        fakeProvider(LlmProviderType.MISTRAL, 'k', 'https://mistral.example.com/v1'),
      ]);
      mockedAxios.post.mockResolvedValue(embeddingResponse(1024));

      await service.generateEmbedding('text', 'org-custom');

      expect(mockedAxios.post.mock.calls[0][0]).toBe('https://mistral.example.com/v1/embeddings');
    });

    it('falls back to hash when the provider call fails', async () => {
      repoFind.mockResolvedValue([fakeProvider(LlmProviderType.MISTRAL)]);
      mockedAxios.post.mockRejectedValue(new Error('upstream 500'));

      const result = await service.generateEmbedding('resilient', 'org-err');

      expect(result!.model).toBe(HASH_EMBEDDING_MODEL);
      expect(result!.vector).toHaveLength(1536);
    });

    it('refuses SSRF-y apiUrl targets and falls back to hash without a network call', async () => {
      repoFind.mockResolvedValue([
        fakeProvider(LlmProviderType.MISTRAL, 'k', 'http://169.254.169.254/v1'),
      ]);

      const result = await service.generateEmbedding('metadata probe', 'org-ssrf');

      expect(mockedAxios.post).not.toHaveBeenCalled();
      expect(result!.model).toBe(HASH_EMBEDDING_MODEL);
    });

    it('caches the resolved provider per org', async () => {
      repoFind.mockResolvedValue([fakeProvider(LlmProviderType.MISTRAL)]);
      mockedAxios.post.mockResolvedValue(embeddingResponse(1024));

      await service.generateEmbedding('one', 'org-cache');
      await service.generateEmbedding('two', 'org-cache');

      expect(repoFind).toHaveBeenCalledTimes(1);
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    });
  });

  // ── mixed-dimension safety ────────────────────────────────────────────

  describe('padToDim', () => {
    it('zero-pads shorter vectors to the target width', () => {
      const padded = EmbeddingService.padToDim([1, 2, 3], 6);
      expect(padded).toEqual([1, 2, 3, 0, 0, 0]);
    });

    it('truncates longer vectors to the target width', () => {
      expect(EmbeddingService.padToDim([1, 2, 3, 4], 2)).toEqual([1, 2]);
    });

    it('returns the vector unchanged when already the target width', () => {
      const v = [1, 2, 3];
      expect(EmbeddingService.padToDim(v, 3)).toBe(v);
    });

    it('zero-padding preserves cosine similarity between same-model vectors', () => {
      // This is why 1024-dim mistral-embed vectors can live in the
      // 1536-wide pgvector column without distorting mistral-vs-mistral
      // distances.
      const a = [0.3, 0.1, 0.9, 0.2];
      const b = [0.5, 0.7, 0.1, 0.4];
      const original = service.cosineSimilarity(a, b);
      const padded = service.cosineSimilarity(
        EmbeddingService.padToDim(a, 10),
        EmbeddingService.padToDim(b, 10),
      );
      expect(padded).toBeCloseTo(original, 10);
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

    it('should return 0 for null or mismatched vectors (mixed-dim guard)', () => {
      expect(service.cosineSimilarity(null as any, [1, 2])).toBe(0);
      expect(service.cosineSimilarity([1, 2], null as any)).toBe(0);
      // A raw 1024-dim mistral vector never silently compares against
      // a 1536-dim openai vector.
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

      const simSimilar = service.cosineSimilarity(base!.vector, similar!.vector);
      const simDifferent = service.cosineSimilarity(base!.vector, different!.vector);

      expect(simSimilar).toBeGreaterThan(simDifferent);
    });
  });
});
