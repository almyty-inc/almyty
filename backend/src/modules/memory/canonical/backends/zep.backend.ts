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
 * Zep backend. Talks to Zep Cloud (default https://api.getzep.com) via
 * /api/v2 with an Api-Key header. Per-call credentials.
 *
 * Capability story:
 *   ✓ vector_search, mode_memory, batch_writes, multi_tenant
 *   ✓ graph_search (Zep is graph-first)
 *   ✓ bi_temporal — Zep's `valid_at` / `expired_at`
 *   ✗ ttl, fts, as_of_queries beyond start, document mode
 */
@Injectable()
export class ZepBackend implements MemoryBackend {
  readonly id = 'zep';
  readonly capabilities = new Set<Capability>([
    'mode_memory', 'vector_search', 'graph_search', 'bi_temporal',
    'multi_tenant', 'batch_writes', 'export',
  ]);
  readonly supported_modes = new Set<Mode>(['memory']);
  private readonly logger = new Logger(ZepBackend.name);
  private readonly clientCache = new Map<string, AxiosInstance>();
  private static readonly CLIENT_CACHE_MAX = 64;

  async init(): Promise<void> {}

  async healthCheck(creds?: BackendCredentials): Promise<BackendHealth> {
    const http = this.client(creds);
    if (!http) return { ok: false, latency_ms: 0, details: { error: 'no_credentials' } };
    const start = Date.now();
    try {
      await http.get('/api/v2/users-ordered', { params: { pageSize: 1 } })
        .catch(() => http.get('/api/v2/users', { params: { limit: 1 } }));
      return { ok: true, latency_ms: Date.now() - start };
    } catch (e: any) {
      return { ok: false, latency_ms: Date.now() - start, details: { status: e?.response?.status, error: e.message } };
    }
  }

  async get(id: string, creds?: BackendCredentials): Promise<MemoryItem | null> {
    const http = this.requireClient(creds);
    try {
      const res = await http.get(`/api/v2/graph/node/${encodeURIComponent(id)}`);
      return this.toCanonical(res.data);
    } catch (e: any) {
      if (e?.response?.status === 404) return null;
      throw e;
    }
  }

  async put(item: MemoryItem, creds?: BackendCredentials): Promise<MemoryItem> {
    const http = this.requireClient(creds);
    const userId = scopeToUserId({ scope_type: item.scope_type, scope_id: item.scope_id });
    await this.ensureUser(http, userId);
    await http.post('/api/v2/graph', {
      data: item.content,
      type: 'message',
      user_id: userId,
    });
    return item;
  }

  async delete(id: string, _mode: 'soft' | 'hard' = 'soft', creds?: BackendCredentials): Promise<boolean> {
    const http = this.requireClient(creds);
    try {
      await http.delete(`/api/v2/graph/node/${encodeURIComponent(id)}`);
      return true;
    } catch (e: any) {
      if (e?.response?.status === 404) return false;
      throw e;
    }
  }

  async list(query: ListQuery, creds?: BackendCredentials): Promise<Page<MemoryItem>> {
    const http = this.requireClient(creds);
    const userId = scopeToUserId(query.scope);
    const res = await http.get(`/api/v2/users/${encodeURIComponent(userId)}/facts`, {
      params: { limit: query.limit ?? 50 },
    }).catch(() => http.get(`/api/v2/graph/nodes`, {
      params: { user_id: userId, limit: query.limit ?? 50 },
    }));
    const rows = (res.data?.facts ?? res.data?.nodes ?? res.data?.results ?? []) as any[];
    const items = rows.map((r) => this.toCanonical(r));
    return { items, total: items.length, cursor: null };
  }

  async search(query: SearchQuery, creds?: BackendCredentials): Promise<RankedItem[]> {
    const http = this.requireClient(creds);
    const userId = scopeToUserId(query.scope);
    const res = await http.post('/api/v2/graph/search', {
      query: query.query, user_id: userId,
      limit: query.top_k ?? 10, scope: 'edges',
    });
    const rows = (res.data?.edges ?? res.data?.results ?? []) as any[];
    return rows.map((r) => ({
      item: this.toCanonical(r),
      score: typeof r.score === 'number' ? r.score : 0,
      signal: 'vector' as const,
    }));
  }

  async supersede(
    oldId: string, newItem: MemoryItem, creds?: BackendCredentials,
  ): Promise<{ old: MemoryItem; new: MemoryItem }> {
    const old = await this.get(oldId, creds);
    if (!old) throw new Error(`zep: cannot supersede missing ${oldId}`);
    await this.put(newItem, creds);
    await this.delete(oldId, 'hard', creds);
    return {
      old: { ...old, valid_until: new Date(), superseded_by: newItem.id },
      new: newItem,
    };
  }

  async asOf(): Promise<never> {
    throw new Error('zep backend does not support as_of_queries beyond ingestion time');
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
    const content = String(raw?.fact ?? raw?.summary ?? raw?.message ?? raw?.content ?? '');
    return {
      id: meta.almyty_id ?? raw?.uuid ?? raw?.id ?? uuidv7(),
      mode: 'memory',
      scope_type: meta.scope_type ?? 'workspace',
      scope_id: meta.scope_id ?? raw?.user_id ?? 'unknown',
      content,
      content_format: 'text',
      content_bytes: Buffer.byteLength(content, 'utf8'),
      embedding: null, embedding_dim: null, embedding_model: null,
      embedding_status: 'skipped', embedding_error: null,
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      metadata: meta, file_refs: [],
      tier: meta.tier ?? 'long',
      valid_from: raw?.valid_at ? new Date(raw.valid_at) : (raw?.created_at ? new Date(raw.created_at) : now),
      valid_until: raw?.expired_at ? new Date(raw.expired_at) : null,
      superseded_by: null, ttl_seconds: null,
      source_uri: null, source_version: null, source_checksum: null,
      chunk_index: null, chunk_total: null, chunk_of: null,
      confidence: typeof raw?.score === 'number' ? raw.score : 1,
      provenance: (meta.provenance as Provenance) ?? ({
        agent_id: null, session_id: null, collab_id: null,
        model: null, provider: null, tool_chain: [],
        created_by: 'sync', source_backend: 'zep',
      } as Provenance),
      created_at: raw?.created_at ? new Date(raw.created_at) : now,
      updated_at: raw?.updated_at ? new Date(raw.updated_at) : now,
      accessed_at: null, access_count: 0, deleted_at: null, deleted_by: null,
    };
  }

  fromCanonical(item: MemoryItem): unknown {
    return {
      data: item.content, type: 'message',
      user_id: scopeToUserId({ scope_type: item.scope_type, scope_id: item.scope_id }),
      metadata: {
        almyty_id: item.id, scope_type: item.scope_type, scope_id: item.scope_id,
        tier: item.tier, tags: item.tags, provenance: item.provenance,
      },
    };
  }

  private async ensureUser(http: AxiosInstance, userId: string): Promise<void> {
    try {
      await http.post('/api/v2/users', { user_id: userId });
    } catch (e: any) {
      if (e?.response?.status !== 409 && e?.response?.status !== 400) throw e;
    }
  }

  private requireClient(creds?: BackendCredentials): AxiosInstance {
    const c = this.client(creds);
    if (!c) throw new Error('zep: missing apiKey credential — set in the org credential store');
    return c;
  }

  private client(creds?: BackendCredentials): AxiosInstance | null {
    if (!creds?.apiKey) return null;
    const baseUrl = creds.baseUrl || 'https://api.getzep.com';
    const cacheKey = `${baseUrl}|${creds.apiKey}`;
    const cached = this.clientCache.get(cacheKey);
    if (cached) return cached;
    const http = axios.create({
      baseURL: baseUrl,
      headers: { Authorization: `Api-Key ${creds.apiKey}` },
      timeout: 15_000, maxRedirects: 0,
    });
    if (this.clientCache.size >= ZepBackend.CLIENT_CACHE_MAX) {
      const oldest = this.clientCache.keys().next().value;
      if (oldest !== undefined) this.clientCache.delete(oldest);
    }
    this.clientCache.set(cacheKey, http);
    return http;
  }
}

function scopeToUserId(scope: ScopeRef): string {
  return `${scope.scope_type}_${scope.scope_id}`;
}
