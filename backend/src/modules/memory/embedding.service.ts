import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import axios from 'axios';
import { LlmProvider, LlmProviderType, LlmProviderStatus } from '../../entities/llm-provider.entity';
import { validateUrl } from '../../common/security/url-validator';
import { LIMITS } from './canonical/canonical.constants';

/**
 * Sentinel model id recorded when the deterministic hash fallback
 * produced the vector (no embedding-capable provider was available).
 */
export const HASH_EMBEDDING_MODEL = 'hash-ngram-v1';

/**
 * Result of an embedding request.
 *
 * `model` and `dim` travel with the vector so the read side can refuse
 * to cosine-compare vectors produced by different models. Two models'
 * embedding spaces are not comparable even when the vectors happen to
 * share a dimensionality — and they usually don't (text-embedding-3-small
 * is 1536-dim, mistral-embed is 1024-dim). The canonical memory store
 * records `embedding_model` per row and the vector search filters on it,
 * so mixed-model vectors are never silently compared.
 */
export interface EmbeddingResult {
  vector: number[];
  /** Model that produced the vector, e.g. 'text-embedding-3-small', 'mistral-embed', or HASH_EMBEDDING_MODEL. */
  model: string;
  /** Raw model output dimensionality, BEFORE any padding to the pgvector column width. */
  dim: number;
  provider: 'openai' | 'mistral' | 'hash';
}

interface EmbeddingBackend {
  provider: 'openai' | 'mistral';
  model: string;
  defaultBaseUrl: string;
  /** Provider-specific request body. Mistral requires `input` to be an array. */
  buildBody: (text: string) => Record<string, unknown>;
}

/**
 * Embedding-capable provider types and how to call them. Keys double as
 * the capability check: a provider type absent from this map cannot
 * serve embeddings and the hash fallback is used instead.
 */
const EMBEDDING_BACKENDS: Partial<Record<LlmProviderType, EmbeddingBackend>> = {
  [LlmProviderType.OPENAI]: {
    provider: 'openai',
    model: 'text-embedding-3-small',
    defaultBaseUrl: 'https://api.openai.com/v1',
    buildBody: (text) => ({ model: 'text-embedding-3-small', input: text }),
  },
  [LlmProviderType.MISTRAL]: {
    provider: 'mistral',
    model: 'mistral-embed',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    buildBody: (text) => ({ model: 'mistral-embed', input: [text] }),
  },
};

/**
 * Preference order when an org has several embedding-capable providers.
 * OpenAI first (1536-dim matches the pgvector column width exactly),
 * then Mistral (1024-dim, zero-padded to the column width — padding
 * with zeros preserves cosine similarity between same-model vectors).
 */
const EMBEDDING_PROVIDER_PREFERENCE: LlmProviderType[] = [
  LlmProviderType.OPENAI,
  LlmProviderType.MISTRAL,
];

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);

  /**
   * Cache: orgId -> { provider, fetchedAt }.
   *
   * Bounded to `PROVIDER_CACHE_MAX_ORGS` entries. Previously the Map was
   * unbounded — every org that called `generateEmbedding` got an entry
   * and it never shrank, so a multi-tenant deployment with thousands of
   * orgs would slowly leak ~1 KB of provider metadata per org.
   *
   * The eviction policy is trivial LRU: when the map hits the cap, we
   * drop the oldest entry (Map preserves insertion order). For a
   * production hot-path that wants better hit rates, swap in `lru-cache`.
   */
  private providerCache = new Map<string, { provider: LlmProvider | null; fetchedAt: number }>();
  private static readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  private static readonly PROVIDER_CACHE_MAX_ORGS = 1000;

  constructor(
    @InjectRepository(LlmProvider)
    private readonly llmProviderRepository: Repository<LlmProvider>,
  ) {}

  /**
   * Generate an embedding for text content.
   *
   * Resolves the org's active embedding-capable providers and calls the
   * preferred one (OpenAI, then Mistral). Falls back to the deterministic
   * hash vector when no capable provider exists or the call fails.
   */
  async generateEmbedding(text: string, organizationId?: string): Promise<EmbeddingResult | null> {
    if (organizationId) {
      try {
        const provider = await this.getEmbeddingProvider(organizationId);
        const backend = provider ? EMBEDDING_BACKENDS[provider.type] : undefined;
        const apiKey = provider?.getDecryptedApiKey();
        if (provider && backend && apiKey) {
          const vector = await this.callEmbeddingApi(backend, text, apiKey, provider.configuration.apiUrl);
          if (vector) {
            return {
              vector,
              model: backend.model,
              dim: vector.length,
              provider: backend.provider,
            };
          }
        }
      } catch (error) {
        this.logger.warn(`Provider embedding failed, falling back to hash: ${error.message}`);
      }
    }

    // Fallback: simple hash-based approach
    try {
      const vector = this.simpleTextVector(text, LIMITS.EMBEDDING_DEFAULT_DIM);
      return {
        vector,
        model: HASH_EMBEDDING_MODEL,
        dim: vector.length,
        provider: 'hash',
      };
    } catch (error) {
      this.logger.warn(`Failed to generate embedding: ${error.message}`);
      return null;
    }
  }

  /**
   * Zero-pad or truncate a vector to `target` length so it fits the
   * fixed-width pgvector column. Zero-padding is cosine-preserving for
   * vectors padded from the same original dimensionality; truncation is
   * not, which is one more reason vector comparisons are additionally
   * gated on `embedding_model` equality by the search layer.
   */
  static padToDim(vector: number[], target: number): number[] {
    if (vector.length === target) return vector;
    if (vector.length > target) return vector.slice(0, target);
    return vector.concat(new Array(target - vector.length).fill(0));
  }

  /**
   * Call an OpenAI-shaped embeddings API (OpenAI, Mistral). Both return
   * `{ data: [{ embedding: number[] }] }`.
   */
  private async callEmbeddingApi(
    backend: EmbeddingBackend,
    text: string,
    apiKey: string,
    apiUrl?: string,
  ): Promise<number[] | null> {
    const baseUrl = apiUrl || backend.defaultBaseUrl;
    const target = `${baseUrl}/embeddings`;
    // SSRF guard. `apiUrl` comes from the LLM provider configuration
    // saved by the user — a hostile "OpenAI-compat" provider pointed
    // at http://169.254.169.254/... would otherwise have the server
    // POST embedding requests (which include user input text) to an
    // internal service.
    const validation = validateUrl(target);
    if (!validation.valid) {
      this.logger.warn(`Refused to reach embedding URL: ${validation.error}`);
      return null;
    }
    const response = await axios.post(
      target,
      backend.buildBody(text.substring(0, 8000)), // Cap input length
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
        maxContentLength: 2 * 1024 * 1024,
        maxBodyLength: 2 * 1024 * 1024,
        maxRedirects: 0,
      },
    );

    const embedding = response.data?.data?.[0]?.embedding;
    if (Array.isArray(embedding) && embedding.length > 0) {
      return embedding;
    }
    return null;
  }

  /**
   * Find the org's preferred active embedding-capable provider
   * (cached, size-bounded). Preference order: OpenAI, then Mistral;
   * ties within a type break on oldest createdAt.
   */
  private async getEmbeddingProvider(organizationId: string): Promise<LlmProvider | null> {
    const cached = this.providerCache.get(organizationId);
    if (cached && Date.now() - cached.fetchedAt < EmbeddingService.CACHE_TTL_MS) {
      return cached.provider;
    }

    try {
      const candidates = await this.llmProviderRepository.find({
        where: {
          organizationId,
          type: In(EMBEDDING_PROVIDER_PREFERENCE),
          status: LlmProviderStatus.ACTIVE,
        },
        order: { createdAt: 'ASC' },
      });
      let chosen: LlmProvider | null = null;
      for (const type of EMBEDDING_PROVIDER_PREFERENCE) {
        chosen = candidates.find((p) => p.type === type) ?? null;
        if (chosen) break;
      }
      this.setCache(organizationId, chosen);
      return chosen;
    } catch (error) {
      this.logger.warn(`Failed to look up embedding provider: ${error.message}`);
      this.setCache(organizationId, null);
      return null;
    }
  }

  private setCache(organizationId: string, provider: LlmProvider | null): void {
    // If we're at capacity, evict the oldest entry (Map preserves
    // insertion order, so the first key is the least recently inserted).
    if (this.providerCache.size >= EmbeddingService.PROVIDER_CACHE_MAX_ORGS) {
      const oldestKey = this.providerCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.providerCache.delete(oldestKey);
      }
    }
    this.providerCache.set(organizationId, { provider, fetchedAt: Date.now() });
  }

  /**
   * Compute cosine similarity between two vectors
   */
  cosineSimilarity(a: number[], b: number[]): number {
    if (!a || !b || a.length !== b.length) return 0;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Simple text-to-vector using character n-grams (deterministic, no API needed).
   * Good enough for basic semantic grouping; upgrade to real embeddings for production.
   */
  private simpleTextVector(text: string, dimensions: number): number[] {
    const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, '');
    const words = normalized.split(/\s+/).filter(w => w.length > 0);
    const vector = new Array(dimensions).fill(0);

    // Use word hashing to fill dimensions
    for (const word of words) {
      for (let n = 1; n <= 3; n++) {
        for (let i = 0; i <= word.length - n; i++) {
          const gram = word.substring(i, i + n);
          const hash = this.hashString(gram);
          const idx = Math.abs(hash) % dimensions;
          vector[idx] += 1.0 / words.length;
        }
      }
    }

    // L2 normalize
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < vector.length; i++) {
        vector[i] /= norm;
      }
    }

    return vector;
  }

  private hashString(str: string): number {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
    }
    return hash;
  }
}