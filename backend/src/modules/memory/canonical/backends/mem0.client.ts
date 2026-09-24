import { safeFetch } from '../../../../common/security/safe-fetch';

/**
 * The slice of the Mem0 platform API the Mem0 backend uses, over the
 * egress-gated `safeFetch`.
 *
 * This replaces the `mem0ai` SDK. Its `MemoryClient` is a thin wrapper
 * over these same endpoints, but the package declares its self-hosted
 * mode's stores as required peers (exact `pg` and `@types/jest` pins,
 * native `better-sqlite3`), which made a plain `npm ci` unresolvable.
 * It also reported every client call, with the account email from
 * `/v1/ping/`, to a third-party analytics endpoint, and wrote a
 * `~/.mem0` config file on the server. None of that belongs in a
 * multi-tenant backend holding other people's keys.
 *
 * Wire format follows mem0ai 3.2.0: `Authorization: Token <key>`,
 * snake_case bodies, entity scoping through `filters`.
 */

export interface Mem0Memory {
  id?: string;
  memory?: string;
  data?: { memory?: string };
  metadata?: Record<string, unknown> | null;
  score?: number;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface Mem0Page {
  results: Mem0Memory[];
  count?: number;
  next?: string | null;
}

export class Mem0Error extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'Mem0Error';
  }
}

export class Mem0NotFoundError extends Mem0Error {
  constructor(message: string) {
    super(message, 404);
    this.name = 'Mem0NotFoundError';
  }
}

const REQUEST_TIMEOUT_MS = 60_000;

export class Mem0Client {
  private readonly host: string;

  constructor(
    private readonly apiKey: string,
    host = 'https://api.mem0.ai',
  ) {
    if (!apiKey || !apiKey.trim()) throw new Error('Mem0 API key is required');
    this.host = host.replace(/\/+$/, '');
  }

  async ping(): Promise<void> {
    const res = await this.request<{ status?: string; message?: string }>('GET', '/v1/ping/');
    if (res?.status !== 'ok') throw new Mem0Error(res?.message || 'API key is invalid');
  }

  add(
    messages: Array<{ role: string; content: string }>,
    options: { userId: string; metadata?: Record<string, unknown> },
  ): Promise<Mem0Memory[] | { results?: Mem0Memory[] }> {
    if (messages.length === 0) throw new Error('Cannot process an empty messages payload.');
    return this.request('POST', '/v3/memories/add/', {
      messages,
      user_id: options.userId,
      ...(options.metadata && { metadata: options.metadata }),
    });
  }

  get(memoryId: string): Promise<Mem0Memory> {
    return this.request('GET', `/v1/memories/${encodeURIComponent(memoryId)}/`);
  }

  getAll(options: { filters: Record<string, unknown>; pageSize?: number }): Promise<Mem0Page> {
    const query = options.pageSize !== undefined ? `?page_size=${options.pageSize}` : '';
    return this.request('POST', `/v3/memories/${query}`, { filters: options.filters });
  }

  search(
    query: string,
    options: { filters: Record<string, unknown>; topK?: number },
  ): Promise<Mem0Page> {
    return this.request('POST', '/v3/memories/search/', {
      query,
      output_format: 'v1.1',
      ...(options.topK !== undefined && { top_k: options.topK }),
      filters: options.filters,
    });
  }

  delete(memoryId: string): Promise<unknown> {
    return this.request('DELETE', `/v1/memories/${encodeURIComponent(memoryId)}/`);
  }

  batchDelete(memoryIds: string[]): Promise<unknown> {
    return this.request('DELETE', '/v1/batch/', {
      memories: memoryIds.map((memory_id) => ({ memory_id })),
    });
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await safeFetch(`${this.host}${path}`, {
      method,
      headers: {
        Authorization: `Token ${this.apiKey}`,
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const message = text || `HTTP ${res.status} error`;
      if (res.status === 404) throw new Mem0NotFoundError(message);
      throw new Mem0Error(message, res.status);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}
