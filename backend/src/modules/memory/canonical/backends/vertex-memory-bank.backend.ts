import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { GoogleAuth, JWT, OAuth2Client } from 'google-auth-library';
import { v7 as uuidv7 } from 'uuid';

import {
  BatchResult,
  Capability,
  ListQuery,
  MemoryChangeEvent,
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
 * Vertex AI Memory Bank backend. Memory Bank doesn't ship a typed
 * JS SDK yet — every Google sample reaches the
 * `:generateMemories` / `:retrieveMemories` endpoints via raw HTTP.
 * What this backend uses from an "official client" is
 * `google-auth-library`: when the org's Credential row carries a
 * service-account JSON (`creds.serviceAccountJson`), we let
 * google-auth mint a short-lived bearer for us; otherwise we accept
 * a pre-minted bearer from the credential resolver.
 *
 * Per-call credentials. No env-var fallback.
 *
 * Capability story:
 *   ✓ vector_search, mode_memory, batch_writes, multi_tenant,
 *     change_feed (polling fallback)
 *   ✗ bi_temporal, ttl, as_of_queries, fts
 */
@Injectable()
export class VertexMemoryBankBackend implements MemoryBackend {
  readonly id = 'vertex-memory-bank';
  readonly schema_version = 1;
  readonly capabilities = new Set<Capability>([
    'mode_memory', 'vector_search', 'multi_tenant',
    'batch_writes', 'change_feed', 'export',
  ]);
  readonly supported_modes = new Set<Mode>(['memory']);
  private readonly logger = new Logger(VertexMemoryBankBackend.name);
  /** HTTP client per (location, credential signature) — bounded. */
  private readonly clientCache = new Map<string, AxiosInstance>();
  /** GoogleAuth-resolved bearer cache per service-account fingerprint. */
  private readonly authCache = new Map<string, { client: JWT | OAuth2Client; expiresAt: number; bearer: string }>();
  private static readonly CLIENT_CACHE_MAX = 64;

  async init(): Promise<void> {}

  async healthCheck(creds?: BackendCredentials): Promise<BackendHealth> {
    const ctx = await this.context(creds);
    if (!ctx) return { ok: false, latency_ms: 0, details: { error: 'no_credentials' } };
    const start = Date.now();
    try {
      await ctx.http.post(
        `/v1beta1/${ctx.engine}:retrieveMemories`,
        { scope: { user_id: '__healthcheck__' }, similaritySearchParams: { searchQuery: 'health', topK: 1 } },
      ).catch(() => undefined);
      return { ok: true, latency_ms: Date.now() - start };
    } catch (e: any) {
      return { ok: false, latency_ms: Date.now() - start, details: { error: e?.message ?? String(e) } };
    }
  }

  async get(_id: string, _creds?: BackendCredentials): Promise<MemoryItem | null> {
    // Memory Bank doesn't expose getMemory by id at v1beta1.
    return null;
  }

  async put(item: MemoryItem, creds?: BackendCredentials): Promise<MemoryItem> {
    const ctx = await this.requireContext(creds);
    await ctx.http.post(`/v1beta1/${ctx.engine}:generateMemories`, {
      directContentsSource: {
        events: [{ content: { role: 'user', parts: [{ text: item.content }] } }],
      },
      scope: { user_id: scopeToUserId({ scope_type: item.scope_type, scope_id: item.scope_id }) },
    });
    return item;
  }

  async delete(_id: string, _mode: 'soft' | 'hard' = 'soft', _creds?: BackendCredentials): Promise<boolean> {
    return false; // Memory Bank v1beta1 has no per-item delete.
  }

  async list(query: ListQuery, creds?: BackendCredentials): Promise<Page<MemoryItem>> {
    const ranked = await this.search({ scope: query.scope, query: '', top_k: query.limit ?? 50 }, creds);
    return { items: ranked.map((r) => r.item), total: ranked.length, cursor: null };
  }

  async search(query: SearchQuery, creds?: BackendCredentials): Promise<RankedItem[]> {
    const ctx = await this.requireContext(creds);
    const userId = scopeToUserId(query.scope);
    const res = await ctx.http.post(`/v1beta1/${ctx.engine}:retrieveMemories`, {
      scope: { user_id: userId },
      similaritySearchParams: { searchQuery: query.query, topK: query.top_k ?? 10 },
    });
    const rows = (res.data?.retrievedMemories ?? []) as any[];
    return rows.map((r) => ({
      item: this.toCanonical(r),
      score: typeof r.distance === 'number' ? 1 - r.distance : 1,
      signal: 'vector' as const,
    }));
  }

  async supersede(): Promise<never> {
    throw new Error('vertex-memory-bank backend does not support bi_temporal supersede');
  }

  async asOf(): Promise<never> {
    throw new Error('vertex-memory-bank backend does not support as_of_queries');
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

  async batchDelete(ids: string[]): Promise<BatchResult> {
    return {
      succeeded: 0, failed: ids.length,
      errors: ids.map((id) => ({ id, error: { kind: 'backend_unavailable', backend: this.id, cause: 'vertex memory bank has no per-item delete' } })),
    };
  }

  async *subscribeChanges(_scope: ScopeRef, since: Date, creds?: BackendCredentials): AsyncIterable<MemoryChangeEvent> {
    const ctx = await this.requireContext(creds);
    let cursor = since;
    while (true) {
      const res = await ctx.http
        .post(`/v1beta1/${ctx.engine}:retrieveMemories`, {
          scope: { user_id: '*' },
          similaritySearchParams: { searchQuery: '', topK: 100 },
        })
        .catch(() => null);
      const rows = (res?.data?.retrievedMemories ?? []) as any[];
      for (const r of rows) {
        const item = this.toCanonical(r);
        if (item.created_at > cursor) yield { op: 'put', item, at: item.created_at };
      }
      cursor = new Date();
      await new Promise((r) => setTimeout(r, 30_000));
    }
  }

  toCanonical(raw: any): MemoryItem {
    const memory = raw?.memory ?? raw;
    const meta = memory?.metadata ?? {};
    const now = new Date();
    const content = String(memory?.fact ?? memory?.content ?? '');
    return {
      id: meta.almyty_id ?? memory?.name?.split('/').pop() ?? uuidv7(),
      mode: 'memory',
      scope_type: meta.scope_type ?? 'workspace',
      scope_id: meta.scope_id ?? 'unknown',
      content, content_format: 'text',
      content_bytes: Buffer.byteLength(content, 'utf8'),
      embedding: null, embedding_dim: null, embedding_model: null,
      embedding_status: 'skipped', embedding_error: null,
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      metadata: meta, file_refs: [],
      tier: meta.tier ?? 'long',
      valid_from: memory?.createTime ? new Date(memory.createTime) : now,
      valid_until: null, superseded_by: null, ttl_seconds: null,
      source_uri: null, source_version: null, source_checksum: null,
      chunk_index: null, chunk_total: null, chunk_of: null,
      confidence: 1,
      provenance: (meta.provenance as Provenance) ?? ({
        agent_id: null, session_id: null, collab_id: null,
        model: null, provider: 'google', tool_chain: [],
        created_by: 'sync', source_backend: 'vertex-memory-bank',
      } as Provenance),
      created_at: memory?.createTime ? new Date(memory.createTime) : now,
      updated_at: memory?.updateTime ? new Date(memory.updateTime) : now,
      accessed_at: null, access_count: 0, deleted_at: null, deleted_by: null,
    };
  }

  fromCanonical(item: MemoryItem): unknown {
    return {
      directContentsSource: {
        events: [{ content: { role: 'user', parts: [{ text: item.content }] } }],
      },
      scope: { user_id: scopeToUserId({ scope_type: item.scope_type, scope_id: item.scope_id }) },
      metadata: {
        almyty_id: item.id, scope_type: item.scope_type, scope_id: item.scope_id,
        tier: item.tier, tags: item.tags,
      },
    };
  }

  private async requireContext(creds?: BackendCredentials): Promise<{ http: AxiosInstance; engine: string }> {
    const ctx = await this.context(creds);
    if (!ctx) {
      throw new Error('vertex-memory-bank: missing engine + (bearer | serviceAccountJson) credentials — set in the org credential store');
    }
    return ctx;
  }

  private async context(creds?: BackendCredentials): Promise<{ http: AxiosInstance; engine: string } | null> {
    if (!creds?.engine) return null;
    const bearer = await this.resolveBearer(creds);
    if (!bearer) return null;
    const location = creds.location || 'us-central1';
    const cacheKey = `${location}|${bearer.slice(-12)}`;
    let http = this.clientCache.get(cacheKey);
    if (!http) {
      http = axios.create({
        baseURL: `https://${location}-aiplatform.googleapis.com`,
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
        timeout: 20_000, maxRedirects: 0,
      });
      if (this.clientCache.size >= VertexMemoryBankBackend.CLIENT_CACHE_MAX) {
        const oldest = this.clientCache.keys().next().value;
        if (oldest !== undefined) this.clientCache.delete(oldest);
      }
      this.clientCache.set(cacheKey, http);
    }
    return { http, engine: creds.engine };
  }

  /**
   * Resolution order:
   *   1. `creds.serviceAccountJson` — full service-account JSON; we
   *      mint and refresh a bearer via `google-auth-library`.
   *   2. `creds.bearer` — a pre-minted access token, used as-is.
   * Pre-minted tokens go stale every hour; a service-account JSON
   * is the durable production setup.
   */
  private async resolveBearer(creds: BackendCredentials): Promise<string | null> {
    const sa = (creds as any).serviceAccountJson;
    if (sa) {
      const fingerprint = JSON.stringify({ client_email: sa.client_email, private_key_id: sa.private_key_id });
      const cached = this.authCache.get(fingerprint);
      const now = Date.now();
      if (cached && cached.expiresAt - 60_000 > now) return cached.bearer;
      const auth = new GoogleAuth({
        credentials: sa,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
      const client = (await auth.getClient()) as JWT | OAuth2Client;
      const token = await client.getAccessToken();
      const bearer = typeof token === 'string' ? token : token?.token ?? null;
      if (!bearer) return null;
      const expiresAt = (client as any).credentials?.expiry_date ?? now + 50 * 60_000;
      this.authCache.set(fingerprint, { client, expiresAt, bearer });
      return bearer;
    }
    return creds.bearer ?? null;
  }
}

function scopeToUserId(scope: ScopeRef): string {
  return `${scope.scope_type}_${scope.scope_id}`;
}
