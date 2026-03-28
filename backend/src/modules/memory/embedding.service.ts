import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);

  /**
   * Generate embedding for text content.
   * For now uses a simple hash-based approach.
   * When pgvector + embedding provider are configured, this switches to real embeddings.
   */
  async generateEmbedding(text: string): Promise<number[] | null> {
    // Simple approach: generate a deterministic numeric hash vector
    // This allows basic similarity matching without requiring an external API
    // Real embedding providers (OpenAI text-embedding-3-small, etc.) can be plugged in later
    try {
      const vector = this.simpleTextVector(text, 256);
      return vector;
    } catch (error) {
      this.logger.warn(`Failed to generate embedding: ${error.message}`);
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
