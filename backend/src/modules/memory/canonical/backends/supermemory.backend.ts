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
 * Supermemory backend. Talks to Supermemory (default
 * https://api.supermemory.ai) over HTTPS with bearer-token auth.
 * Per-call credentials.
 *
 * Capability story:
 *   ✓ vector_search, fts, hybrid_search, mode_memory, mode_document,
 *     batch_writes, multi_tenant
 *   ✗ bi_temporal, ttl, as_of_queries, change_feed, soft_delete
 */
@Injectable()
export class SupermemoryBackend implements MemoryBackend {
  readonly id = 'supermemory';
  readonly schema_version = 1;
  readonly capabilities = new Set<Capability>([
    'mode_memory', 'mode_document', 'vector_search', 'fts',
    'hybrid_search', 'multi_tenant', 'batch_writes', 'export',
  ]);
  readonly supported_modes = new Set<Mode>(['memory', 'document']);
  private readonly logger = new Logger(SupermemoryBackend.name);
  private readonly clientCache = new Map<string, AxiosInstance>();
  private static readonly CLIENT_CACHE_MAX = 64;

  async init(): Promise<void> {}

  async healthCheck(creds?: BackendCredentials): Promise<BackendHealth> {
    const http = this.client(creds);
    if (!http) return { ok: false, latency_ms: 0, details: { error: 'no_credentials' } };
    const start = Date.now();
    try {
      await http.get('/v3/memories', { params: { limit: 1 } });
      return { ok: true, latency_ms: Date.now() - start };
    } catch (e: any) {
      return { ok: false, latency_ms: Date.now() - start, details: { status: e?.response?.status, error: e.message } };
    }
  }

  async get(id: string, creds?: BackendCredentials): Promise<MemoryItem | null> {
    const http = this.requireClient(creds);
    try {
      const res = await http.get(`/v3/memories/${encodeURIComponent(id)}`);
      return this.toCanonical(res.data);
    } catch (e: any) {
      if (e?.response?.status === 404) return null;
      throw e;
    }
  }

  async put(item: MemoryItem, creds?: BackendCredentials): Promise<MemoryItem> {
    const http = this.requireClient(creds);
    const res = await http.post('/v3/memories', this.fromCanonical(item));
    const created = res.data?.memory ?? res.data;
    return this.toCanonical({
      ...created,
      metadata: { ...(created?.metadata || {}), almyty_id: item.id, supermemory_id: created?.id },
    });
  }

  async delete(id: string, _mode: 'soft' | 'hard' = 'soft', creds?: BackendCredentials): Promise<boolean> {
    const http = this.requireClient(creds);
    try {
      await http.delete(`/v3/memories/${encodeURIComponent(id)}`);
      return true;
    } catch (e: any) {
      if (e?.response?.status === 404) return false;
      throw e;
    }
  }

  async list(query: ListQuery, creds?: BackendCredentials): Promise<Page<MemoryItem>> {
    const http = this.requireClient(creds);
    const containerTag = scopeToTag(query.scope);
    const res = await http.get('/v3/memories', {
      params: { containerTags: containerTag, limit: query.limit ?? 50 },
    });
    const rows = (res.data?.memories ?? res.data?.results ?? []) as any[];
    const items = rows.map((r) => this.toCanonical(r));
    return { items, total: items.length, cursor: res.data?.next_cursor ?? null };
  }

  async search(query: SearchQuery, creds?: BackendCredentials): Promise<RankedItem[]> {
    const http = this.requireClient(creds);
    const containerTag = scopeToTag(query.scope);
    const res = await http.post('/v3/search', {
      q: query.query, containerTags: [containerTag], limit: query.top_k ?? 10,
    });
    const rows = (res.data?.results ?? []) as any[];
    return rows.map((r) => ({
      item: this.toCanonical(r),
      score: typeof r.score === 'number' ? r.score : 0,
      signal: 'hybrid' as const,
    }));
  }

  async supersede(): Promise<never> {
    throw new Error('supermemory backend does not support bi_temporal supersede');
  }

  async asOf(): Promise<never> {
    throw new Error('supermemory backend does not support as_of_queries');
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
    const meta = raw?.metadata ?? {};
    const now = new Date();
    const content = String(raw?.content ?? raw?.text ?? raw?.summary ?? '');
    const isDoc = !!meta.source_uri;
    return {
      id: meta.almyty_id ?? raw?.id ?? uuidv7(),
      mode: isDoc ? 'document' : 'memory',
      scope_type: meta.scope_type ?? 'workspace',
      scope_id: meta.scope_id ?? 'unknown',
      content,
      content_format: meta.content_format ?? 'text',
      content_bytes: Buffer.byteLength(content, 'utf8'),
      embedding: null, embedding_dim: null, embedding_model: meta.embedding_model ?? null,
      embedding_status: 'skipped', embedding_error: null,
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      metadata: meta, file_refs: [],
      tier: isDoc ? null : (meta.tier ?? 'project'),
      valid_from: isDoc ? null : (raw?.created_at ? new Date(raw.created_at) : now),
      valid_until: null, superseded_by: null, ttl_seconds: null,
      source_uri: meta.source_uri ?? null,
      source_version: meta.source_version ?? (isDoc ? 1 : null),
      source_checksum: meta.source_checksum ?? null,
      chunk_index: meta.chunk_index ?? null,
      chunk_total: meta.chunk_total ?? null,
      chunk_of: meta.chunk_of ?? null,
      confidence: typeof raw?.score === 'number' ? raw.score : 1,
      provenance: (meta.provenance as Provenance) ?? ({
        agent_id: null, session_id: null, collab_id: null,
        model: null, provider: null, tool_chain: [],
        created_by: 'sync', source_backend: 'supermemory',
      } as Provenance),
      created_at: raw?.created_at ? new Date(raw.created_at) : now,
      updated_at: raw?.updated_at ? new Date(raw.updated_at) : now,
      accessed_at: null, access_count: 0, deleted_at: null, deleted_by: null,
    };
  }

  fromCanonical(item: MemoryItem): unknown {
    return {
      content: item.content,
      containerTags: [scopeToTag({ scope_type: item.scope_type, scope_id: item.scope_id })],
      metadata: {
        almyty_id: item.id, scope_type: item.scope_type, scope_id: item.scope_id,
        tier: item.tier, tags: item.tags, provenance: item.provenance,
        source_uri: item.source_uri, source_version: item.source_version,
      },
    };
  }

  private requireClient(creds?: BackendCredentials): AxiosInstance {
    const c = this.client(creds);
    if (!c) throw new Error('supermemory: missing apiKey credential — set in the org credential store');
    return c;
  }

  private client(creds?: BackendCredentials): AxiosInstance | null {
    if (!creds?.apiKey) return null;
    const baseUrl = creds.baseUrl || 'https://api.supermemory.ai';
    const cacheKey = `${baseUrl}|${creds.apiKey}`;
    const cached = this.clientCache.get(cacheKey);
    if (cached) return cached;
    const http = axios.create({
      baseURL: baseUrl,
      headers: { Authorization: `Bearer ${creds.apiKey}` },
      timeout: 15_000, maxRedirects: 0,
    });
    if (this.clientCache.size >= SupermemoryBackend.CLIENT_CACHE_MAX) {
      const oldest = this.clientCache.keys().next().value;
      if (oldest !== undefined) this.clientCache.delete(oldest);
    }
    this.clientCache.set(cacheKey, http);
    return http;
  }
}

function scopeToTag(scope: ScopeRef): string {
  return `${scope.scope_type}_${scope.scope_id}`;
}
