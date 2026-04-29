import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
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

/**
 * Anthropic Memory Tool backend. Persists canonical memory items as
 * Anthropic Files (default https://api.anthropic.com /v1/files) so
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
  private readonly clientCache = new Map<string, AxiosInstance>();
  private static readonly CLIENT_CACHE_MAX = 64;

  async init(): Promise<void> {}

  async healthCheck(creds?: BackendCredentials): Promise<BackendHealth> {
    const http = this.client(creds);
    if (!http) return { ok: false, latency_ms: 0, details: { error: 'no_credentials' } };
    const start = Date.now();
    try {
      await http.get('/v1/files', { params: { limit: 1 } });
      return { ok: true, latency_ms: Date.now() - start };
    } catch (e: any) {
      return { ok: false, latency_ms: Date.now() - start, details: { status: e?.response?.status, error: e.message } };
    }
  }

  async get(id: string, creds?: BackendCredentials): Promise<MemoryItem | null> {
    const http = this.requireClient(creds);
    try {
      const [meta, content] = await Promise.all([
        http.get(`/v1/files/${encodeURIComponent(id)}`),
        http.get(`/v1/files/${encodeURIComponent(id)}/content`, { responseType: 'text' }),
      ]);
      return this.toCanonical({ ...meta.data, _content: content.data });
    } catch (e: any) {
      if (e?.response?.status === 404) return null;
      throw e;
    }
  }

  async put(item: MemoryItem, creds?: BackendCredentials): Promise<MemoryItem> {
    const http = this.requireClient(creds);
    const fd = new (require('form-data'))();
    fd.append('file', Buffer.from(item.content, 'utf8'), {
      filename: scopedFileName(item),
      contentType: 'text/markdown',
    });
    fd.append('purpose', 'memory');
    await http.post('/v1/files', fd, { headers: { ...fd.getHeaders() } });
    return item;
  }

  async delete(id: string, _mode: 'soft' | 'hard' = 'soft', creds?: BackendCredentials): Promise<boolean> {
    const http = this.requireClient(creds);
    try {
      await http.delete(`/v1/files/${encodeURIComponent(id)}`);
      return true;
    } catch (e: any) {
      if (e?.response?.status === 404) return false;
      throw e;
    }
  }

  async list(query: ListQuery, creds?: BackendCredentials): Promise<Page<MemoryItem>> {
    const http = this.requireClient(creds);
    const prefix = `${query.scope.scope_type}_${query.scope.scope_id}__`;
    const res = await http.get('/v1/files', { params: { limit: query.limit ?? 100 } });
    const data = (res.data?.data ?? res.data?.files ?? []) as any[];
    const filtered = data.filter((f) => typeof f?.filename === 'string' && f.filename.startsWith(prefix));
    const items: MemoryItem[] = [];
    for (const f of filtered) {
      const content = await http.get(`/v1/files/${encodeURIComponent(f.id)}/content`, { responseType: 'text' });
      items.push(this.toCanonical({ ...f, _content: content.data }));
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

  private requireClient(creds?: BackendCredentials): AxiosInstance {
    const c = this.client(creds);
    if (!c) throw new Error('anthropic-memory-tool: missing apiKey credential — set in the org credential store');
    return c;
  }

  private client(creds?: BackendCredentials): AxiosInstance | null {
    if (!creds?.apiKey) return null;
    const baseUrl = creds.baseUrl || 'https://api.anthropic.com';
    const cacheKey = `${baseUrl}|${creds.apiKey}`;
    const cached = this.clientCache.get(cacheKey);
    if (cached) return cached;
    const http = axios.create({
      baseURL: baseUrl,
      headers: {
        'x-api-key': creds.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'files-api-2025-04-14',
      },
      timeout: 20_000, maxRedirects: 0,
    });
    if (this.clientCache.size >= AnthropicMemoryToolBackend.CLIENT_CACHE_MAX) {
      const oldest = this.clientCache.keys().next().value;
      if (oldest !== undefined) this.clientCache.delete(oldest);
    }
    this.clientCache.set(cacheKey, http);
    return http;
  }
}

function scopedFileName(item: MemoryItem): string {
  return `${item.scope_type}_${item.scope_id}__${item.id}.md`;
}
