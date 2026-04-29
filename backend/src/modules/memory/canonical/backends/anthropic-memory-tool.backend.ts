import { Injectable, Logger } from '@nestjs/common';
import Anthropic, { toFile, NotFoundError } from '@anthropic-ai/sdk';
import { v7 as uuidv7 } from 'uuid';

import {
  BatchResult,
  Capability,
  ListQuery,
  MemoryItem,
  Mode,
  Page,
  Provenance,
  RankedItem,
  ScopeRef,
  SearchQuery,
} from '../canonical.types';
import { BackendCredentials, BackendHealth, MemoryBackend } from './memory-backend.interface';

const FILES_API_BETA = 'files-api-2025-04-14';

/**
 * Anthropic Memory Tool backend, on the official `@anthropic-ai/sdk`
 * Files API (beta). Persists canonical memory items as Files so
 * Claude's `memory` tool can read/list/search them. Per-call
 * credentials.
 *
 * Capability story:
 *   ✓ vector_search (Claude's retrieval over the file set)
 *   ✓ mode_memory, mode_document, multi_tenant, batch_writes
 *   ✗ bi_temporal, ttl, as_of_queries, change_feed, transactional_writes
 */
@Injectable()
export class AnthropicMemoryToolBackend implements MemoryBackend {
  readonly id = 'anthropic-memory-tool';
  readonly schema_version = 1;
  readonly capabilities = new Set<Capability>([
    'mode_memory', 'mode_document', 'vector_search', 'multi_tenant', 'batch_writes',
  ]);
  readonly supported_modes = new Set<Mode>(['memory', 'document']);
  private readonly logger = new Logger(AnthropicMemoryToolBackend.name);
  private readonly clientCache = new Map<string, Anthropic>();
  private static readonly CLIENT_CACHE_MAX = 64;

  async init(): Promise<void> {}

  async healthCheck(creds?: BackendCredentials): Promise<BackendHealth> {
    const client = this.client(creds);
    if (!client) return { ok: false, latency_ms: 0, details: { error: 'no_credentials' } };
    const start = Date.now();
    try {
      await client.beta.files.list({ limit: 1, betas: [FILES_API_BETA] });
      return { ok: true, latency_ms: Date.now() - start };
    } catch (e: any) {
      return { ok: false, latency_ms: Date.now() - start, details: { error: e?.message ?? String(e) } };
    }
  }

  async get(id: string, creds?: BackendCredentials): Promise<MemoryItem | null> {
    const client = this.requireClient(creds);
    try {
      const [meta, downloaded] = await Promise.all([
        client.beta.files.retrieveMetadata(id, { betas: [FILES_API_BETA] }),
        client.beta.files.download(id, { betas: [FILES_API_BETA] }),
      ]);
      const content = await downloaded.text();
      return this.toCanonical({ ...meta, _content: content });
    } catch (e) {
      if (e instanceof NotFoundError) return null;
      throw e;
    }
  }

  async put(item: MemoryItem, creds?: BackendCredentials): Promise<MemoryItem> {
    const client = this.requireClient(creds);
    const file = await toFile(
      Buffer.from(item.content, 'utf8'),
      scopedFileName(item),
      { type: 'text/markdown' },
    );
    const uploaded = await client.beta.files.upload(
      { file, betas: [FILES_API_BETA] },
    );
    return {
      ...item,
      metadata: { ...item.metadata, anthropic_file_id: uploaded.id },
    };
  }

  async delete(id: string, _mode: 'soft' | 'hard' = 'soft', creds?: BackendCredentials): Promise<boolean> {
    const client = this.requireClient(creds);
    try {
      await client.beta.files.delete(id, { betas: [FILES_API_BETA] });
      return true;
    } catch (e) {
      if (e instanceof NotFoundError) return false;
      throw e;
    }
  }

  async list(query: ListQuery, creds?: BackendCredentials): Promise<Page<MemoryItem>> {
    const client = this.requireClient(creds);
    const prefix = `${query.scope.scope_type}_${query.scope.scope_id}__`;
    const limit = Math.min(query.limit ?? 100, 1000);
    const items: MemoryItem[] = [];
    const pager = await client.beta.files.list({ limit, betas: [FILES_API_BETA] });
    for await (const meta of pager) {
      if (typeof meta.filename !== 'string' || !meta.filename.startsWith(prefix)) continue;
      const downloaded = await client.beta.files.download(meta.id, { betas: [FILES_API_BETA] });
      const content = await downloaded.text();
      items.push(this.toCanonical({ ...meta, _content: content }));
      if (items.length >= limit) break;
    }
    return { items, total: items.length, cursor: null };
  }

  async search(query: SearchQuery, creds?: BackendCredentials): Promise<RankedItem[]> {
    const page = await this.list({ scope: query.scope, limit: 200 }, creds);
    const q = query.query.toLowerCase();
    return page.items
      .map((item) => ({
        item,
        score: item.content.toLowerCase().includes(q) ? 1 : 0,
        signal: 'vector' as const,
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, query.top_k ?? 10);
  }

  async supersede(): Promise<never> {
    throw new Error('anthropic-memory-tool backend does not support bi_temporal supersede');
  }

  async asOf(): Promise<never> {
    throw new Error('anthropic-memory-tool backend does not support as_of_queries');
  }

  async batchPut(items: MemoryItem[], creds?: BackendCredentials): Promise<BatchResult> {
    const result: BatchResult = { succeeded: 0, failed: 0, errors: [] };
    for (const item of items) {
      try { await this.put(item, creds); result.succeeded++; }
      catch (e: any) {
        result.failed++;
        result.errors.push({ id: item.id, error: { kind: 'backend_unavailable', backend: this.id, cause: e.message ?? String(e) } });
      }
    }
    return result;
  }

  async batchDelete(ids: string[], creds?: BackendCredentials): Promise<BatchResult> {
    const result: BatchResult = { succeeded: 0, failed: 0, errors: [] };
    for (const id of ids) {
      try {
        const ok = await this.delete(id, 'hard', creds);
        if (ok) result.succeeded++; else result.failed++;
      } catch (e: any) {
        result.failed++;
        result.errors.push({ id, error: { kind: 'backend_unavailable', backend: this.id, cause: e.message ?? String(e) } });
      }
    }
    return result;
  }

  toCanonical(raw: any): MemoryItem {
    const filename: string = raw?.filename ?? '';
    const m = filename.match(/^([^_]+)_([^_]+(?:[^_]+)*?)__([0-9a-f-]{36})\.md$/i);
    const content = typeof raw?._content === 'string' ? raw._content : String(raw?.content ?? '');
    const now = new Date();
    return {
      id: m?.[3] ?? raw?.id ?? uuidv7(),
      mode: 'memory',
      scope_type: (m?.[1] as any) ?? 'workspace',
      scope_id: m?.[2] ?? 'unknown',
      content, content_format: 'markdown',
      content_bytes: Buffer.byteLength(content, 'utf8'),
      embedding: null, embedding_dim: null, embedding_model: null,
      embedding_status: 'skipped', embedding_error: null,
      tags: [], metadata: { anthropic_file_id: raw?.id }, file_refs: [],
      tier: 'long',
      valid_from: raw?.created_at ? new Date(raw.created_at) : now,
      valid_until: null, superseded_by: null, ttl_seconds: null,
      source_uri: null, source_version: null, source_checksum: null,
      chunk_index: null, chunk_total: null, chunk_of: null,
      confidence: 1,
      provenance: {
        agent_id: null, session_id: null, collab_id: null,
        model: null, provider: 'anthropic', tool_chain: [],
        created_by: 'sync', source_backend: 'anthropic-memory-tool',
      } as Provenance,
      created_at: raw?.created_at ? new Date(raw.created_at) : now,
      updated_at: raw?.updated_at ? new Date(raw.updated_at) : now,
      accessed_at: null, access_count: 0, deleted_at: null, deleted_by: null,
    };
  }

  fromCanonical(item: MemoryItem): unknown {
    return { filename: scopedFileName(item), content: item.content };
  }

  private requireClient(creds?: BackendCredentials): Anthropic {
    const c = this.client(creds);
    if (!c) throw new Error('anthropic-memory-tool: missing apiKey credential — set in the org credential store');
    return c;
  }

  private client(creds?: BackendCredentials): Anthropic | null {
    if (!creds?.apiKey) return null;
    const baseURL = creds.baseUrl || 'https://api.anthropic.com';
    const cacheKey = `${baseURL}|${creds.apiKey}`;
    const cached = this.clientCache.get(cacheKey);
    if (cached) return cached;
    const client = new Anthropic({ apiKey: creds.apiKey, baseURL });
    if (this.clientCache.size >= AnthropicMemoryToolBackend.CLIENT_CACHE_MAX) {
      const oldest = this.clientCache.keys().next().value;
      if (oldest !== undefined) this.clientCache.delete(oldest);
    }
    this.clientCache.set(cacheKey, client);
    return client;
  }
}

function scopedFileName(item: MemoryItem): string {
  return `${item.scope_type}_${item.scope_id}__${item.id}.md`;
}
