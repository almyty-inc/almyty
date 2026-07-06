import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import axios from 'axios';
import { LlmProvider, LlmProviderType, LlmProviderStatus } from '../../entities/llm-provider.entity';
import {
  validateUrl,
  validateUrlAllowingPrivate,
  ollamaPrivateUrlsAllowed,
} from '../../common/security/url-validator';
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
  /** Model that produced the vector, e.g. 'text-embedding-3-small', 'mistral-embed', 'nomic-embed-text', or HASH_EMBEDDING_MODEL. */
  model: string;
  /** Raw model output dimensionality, BEFORE any padding to the pgvector column width. */
  dim: number;
  provider: 'openai' | 'mistral' | 'ollama' | 'hash';
}

interface EmbeddingBackend {
  provider: 'openai' | 'mistral' | 'ollama';
  /** Default embedding model; overridable per provider via configuration.embeddingModel. */
  defaultModel: string;
  defaultBaseUrl: string;
  /** Endpoint path appended to the base URL. */
  path: string;
  /** false → the backend works without an API key (Ollama). */
  requiresApiKey: boolean;
  /** Provider-specific request body. Mistral requires `input` to be an array. */
  buildBody: (text: string, model: string) => Record<string, unknown>;
  /** Pull the vector out of the provider-specific response shape. */
  extractVector: (data: any) => unknown;
}

/**
 * Embedding-capable provider types and how to call them. Keys double as
 * the capability check: a provider type absent from this map cannot
 * serve embeddings and the hash fallback is used instead.
 */
const EMBEDDING_BACKENDS: Partial<Record<LlmProviderType, EmbeddingBackend>> = {
  [LlmProviderType.OPENAI]: {
    provider: 'openai',
    defaultModel: 'text-embedding-3-small',
    defaultBaseUrl: 'https://api.openai.com/v1',
    path: '/embeddings',
    requiresApiKey: true,
    buildBody: (text, model) => ({ model, input: text }),
    extractVector: (data) => data?.data?.[0]?.embedding,
  },
  [LlmProviderType.MISTRAL]: {
    provider: 'mistral',
    defaultModel: 'mistral-embed',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    path: '/embeddings',
    requiresApiKey: true,
    buildBody: (text, model) => ({ model, input: [text] }),
    extractVector: (data) => data?.data?.[0]?.embedding,
  },
  [LlmProviderType.OLLAMA]: {
    provider: 'ollama',
    // nomic-embed-text is 768-dim; other local models differ. Dims vary
    // per model and each stored vector records its model + dim, so the
    // read side never cosine-compares across models (see EmbeddingResult).
    defaultModel: 'nomic-embed-text',
    defaultBaseUrl: 'http://localhost:11434',
    // Native embed endpoint (POST /api/embed { model, input }) — the
    // OpenAI-compat /v1/embeddings surface exists but /api/embed is the
    // canonical one and supports every embedding-capable local model.
    path: '/api/embed',
    requiresApiKey: false,
    buildBody: (text, model) => ({ model, input: text }),
    extractVector: (data) => data?.embeddings?.[0],
  },
};

/**
 * Preference order when an org has several embedding-capable providers.
 * OpenAI first (1536-dim matches the pgvector column width exactly),
 * then Mistral (1024-dim, zero-padded to the column width — padding
 * with zeros preserves cosine similarity between same-model vectors),
 * then Ollama (local inference; typically 768-dim nomic-embed-text,
 * also zero-padded).
 */
const EMBEDDING_PROVIDER_PREFERENCE: LlmProviderType[] = [
  LlmProviderType.OPENAI,
  LlmProviderType.MISTRAL,
  LlmProviderType.OLLAMA,
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
   * preferred one (OpenAI, then Mistral, then Ollama). Falls back to the
   * deterministic hash vector when no capable provider exists or the
   * call fails.
   */
  async generateEmbedding(text: string, organizationId?: string): Promise<EmbeddingResult | null> {
    if (organizationId) {
      try {
        const provider = await this.getEmbeddingProvider(organizationId);
        const backend = provider ? EMBEDDING_BACKENDS[provider.type] : undefined;
        const apiKey = provider?.getDecryptedApiKey();
        // Keyless backends (Ollama) may proceed without an API key.
        if (provider && backend && (apiKey || !backend.requiresApiKey)) {
          const model = provider.configuration?.embeddingModel || backend.defaultModel;
          const vector = await this.callEmbeddingApi(
            backend,
            text,
            model,
            apiKey,
            this.resolveEmbeddingBaseUrl(provider, backend),
          );
          if (vector) {
            return {
              vector,
              model,
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
   * Resolve the base URL for an embedding call. Ollama's configured
   * `apiUrl` is the server root and may carry a /v1 suffix (the
   * OpenAI-compat surface used for chat) — strip it, because the native
   * embed endpoint lives at the root (/api/embed).
   */
  private resolveEmbeddingBaseUrl(provider: LlmProvider, backend: EmbeddingBackend): string {
    const configured = provider.configuration?.apiUrl;
    if (backend.provider === 'ollama') {
      const base = (configured || backend.defaultBaseUrl).replace(/\/+$/, '');
      return base.toLowerCase().endsWith('/v1')
        ? base.slice(0, -3).replace(/\/+$/, '')
        : base;
    }
    return configured || backend.defaultBaseUrl;
  }

  /**
   * Call an embeddings API. OpenAI and Mistral share the OpenAI shape
   * (`{ data: [{ embedding: [...] }] }`); Ollama's native /api/embed
   * returns `{ embeddings: [[...]] }` — each backend supplies its own
   * body builder and vector extractor.
   */
  private async callEmbeddingApi(
    backend: EmbeddingBackend,
    text: string,
    model: string,
    apiKey: string | undefined,
    baseUrl: string,
  ): Promise<number[] | null> {
    const target = `${baseUrl}${backend.path}`;
    // SSRF guard. `apiUrl` comes from the LLM provider configuration
    // saved by the user — a hostile "OpenAI-compat" provider pointed
    // at http://169.254.169.254/... would otherwise have the server
    // POST embedding requests (which include user input text) to an
    // internal service. Ollama providers honor the self-hosting escape
    // hatch OLLAMA_ALLOW_PRIVATE_URLS=true (still http(s)-only, no
    // embedded credentials) so a machine-local Ollama can serve
    // embeddings; every other backend always gets the full gate.
    const allowPrivate = backend.provider === 'ollama' && ollamaPrivateUrlsAllowed();
    const validation = allowPrivate ? validateUrlAllowingPrivate(target) : validateUrl(target);
    if (!validation.valid) {
      this.logger.warn(`Refused to reach embedding URL: ${validation.error}`);
      return null;
    }
    // Keyless backends (Ollama) send no Authorization header; when a
    // key is configured anyway (auth proxy in front of Ollama) it is
    // forwarded as a Bearer token.
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    const response = await axios.post(
      target,
      backend.buildBody(text.substring(0, 8000), model), // Cap input length
      {
        headers,
        timeout: 10000,
        maxContentLength: 2 * 1024 * 1024,
        maxBodyLength: 2 * 1024 * 1024,
        maxRedirects: 0,
      },
    );

    const embedding = backend.extractVector(response.data);
    if (Array.isArray(embedding) && embedding.length > 0) {
      return embedding as number[];
    }
    return null;
  }

  /**
   * Find the org's preferred active embedding-capable provider
   * (cached, size-bounded). Preference order: OpenAI, Mistral, Ollama;
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