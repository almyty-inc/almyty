import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios from 'axios';
import { LlmProvider, LlmProviderType, LlmProviderStatus } from '../../entities/llm-provider.entity';
import { validateUrl } from '../../common/security/url-validator';

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
   * Generate embedding for text content.
   * Tries real OpenAI embeddings first, falls back to hash-based approach.
   */
  async generateEmbedding(text: string, organizationId?: string): Promise<number[] | null> {
    // Try real embeddings via OpenAI provider
    if (organizationId) {
      try {
        const provider = await this.getOpenAIProvider(organizationId);
        if (provider?.configuration?.apiKey) {
          const embedding = await this.callOpenAIEmbedding(text, provider.configuration.apiKey, provider.configuration.apiUrl);
          if (embedding) {
            return embedding;
          }
        }
      } catch (error) {
        this.logger.warn(`OpenAI embedding failed, falling back to hash: ${error.message}`);
      }
    }

    // Fallback: simple hash-based approach
    try {
      const vector = this.simpleTextVector(text, 256);
      return vector;
    } catch (error) {
      this.logger.warn(`Failed to generate embedding: ${error.message}`);
      return null;
    }
  }

  /**
   * Call OpenAI embeddings API
   */
  private async callOpenAIEmbedding(text: string, apiKey: string, apiUrl?: string): Promise<number[] | null> {
    const baseUrl = apiUrl || 'https://api.openai.com/v1';
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
      {
        model: 'text-embedding-3-small',
        input: text.substring(0, 8000), // Cap input length
      },
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
   * Find an active OpenAI provider in the org (cached, size-bounded).
   */
  private async getOpenAIProvider(organizationId: string): Promise<LlmProvider | null> {
    const cached = this.providerCache.get(organizationId);
    if (cached && Date.now() - cached.fetchedAt < EmbeddingService.CACHE_TTL_MS) {
      return cached.provider;
    }

    try {
      const provider = await this.llmProviderRepository.findOne({
        where: {
          organizationId,
          type: LlmProviderType.OPENAI,
          status: LlmProviderStatus.ACTIVE,
        },
        order: { createdAt: 'ASC' },
      });
      this.setCache(organizationId, provider);
      return provider;
    } catch (error) {
      this.logger.warn(`Failed to look up OpenAI provider: ${error.message}`);
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
