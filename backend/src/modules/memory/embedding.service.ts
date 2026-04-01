import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios from 'axios';
import { LlmProvider, LlmProviderType, LlmProviderStatus } from '../../entities/llm-provider.entity';

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);

  /** Cache: orgId -> { provider, fetchedAt } */
  private providerCache = new Map<string, { provider: LlmProvider | null; fetchedAt: number }>();
  private static readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

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
    const response = await axios.post(
      `${baseUrl}/embeddings`,
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
      },
    );

    const embedding = response.data?.data?.[0]?.embedding;
    if (Array.isArray(embedding) && embedding.length > 0) {
      return embedding;
    }
    return null;
  }

  /**
   * Find an active OpenAI provider in the org (cached)
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
      this.providerCache.set(organizationId, { provider, fetchedAt: Date.now() });
      return provider;
    } catch (error) {
      this.logger.warn(`Failed to look up OpenAI provider: ${error.message}`);
      this.providerCache.set(organizationId, { provider: null, fetchedAt: Date.now() });
      return null;
    }
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
