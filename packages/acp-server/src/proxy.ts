/**
 * HTTP proxy client to the almyty backend REST API.
 *
 * Provides typed methods for agent discovery, invocation, streaming,
 * and autonomous run management. All stdout is reserved for the ACP
 * protocol; diagnostics go to stderr.
 */

import { createParser, type EventSourceMessage } from 'eventsource-parser';

/** Default timeouts (ms). */
const DISCOVERY_TIMEOUT_MS = 15_000;
const INVOKE_TIMEOUT_MS = 120_000;

/** Minimal agent shape returned by the backend. */
export interface AgentInfo {
  id: string;
  name: string;
  slug?: string;
  description?: string;
  mode: 'workflow' | 'autonomous';
  status?: string;
  pipeline?: { nodes?: PipelineNode[] };
}

export interface PipelineNode {
  id: string;
  type: string;
  label?: string;
  config?: Record<string, unknown>;
}

/** Autonomous run state from the backend. */
export interface AgentRun {
  id: string;
  agentId: string;
  status: 'pending' | 'running' | 'waiting_input' | 'completed' | 'failed' | 'cancelled';
  conversationId?: string;
  output?: unknown;
  error?: string;
}

/** A single SSE event emitted by the streaming endpoints. */
export interface StreamEvent {
  event: string;
  data: Record<string, unknown>;
}

export class AlmytyProxy {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  // ── Agent discovery ────────────────────────────────────────────

  async listAgents(): Promise<AgentInfo[]> {
    const data: any = await this.get('/agents', DISCOVERY_TIMEOUT_MS);
    return data?.agents || data?.data?.agents || (Array.isArray(data) ? data : []);
  }

  async getAgent(id: string): Promise<AgentInfo> {
    const data: any = await this.get(`/agents/${encodeURIComponent(id)}`, DISCOVERY_TIMEOUT_MS);
    return data?.data || data;
  }

  // ── Workflow invocation ────────────────────────────────────────

  async invokeAgent(id: string, input: Record<string, unknown>): Promise<unknown> {
    return this.post(`/agents/${encodeURIComponent(id)}/invoke`, input, INVOKE_TIMEOUT_MS);
  }

  /**
   * Stream a workflow agent execution via SSE. Yields StreamEvent objects
   * as they arrive. The caller is responsible for consuming the async
   * iterator; aborting the signal will terminate the stream.
   */
  async *streamAgent(
    id: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    yield* this.ssePost(
      `/agents/${encodeURIComponent(id)}/stream`,
      input,
      signal,
    );
  }

  // ── Autonomous run management ──────────────────────────────────

  async startRun(id: string, input: Record<string, unknown>): Promise<AgentRun> {
    const data: any = await this.post(`/agents/${encodeURIComponent(id)}/runs`, { input }, INVOKE_TIMEOUT_MS);
    return data?.data || data;
  }

  async getRun(agentId: string, runId: string): Promise<AgentRun> {
    return this.get(
      `/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`,
      DISCOVERY_TIMEOUT_MS,
    );
  }

  async sendRunInput(agentId: string, runId: string, input: Record<string, unknown>): Promise<AgentRun> {
    return this.post(
      `/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/input`,
      input,
      INVOKE_TIMEOUT_MS,
    );
  }

  async cancelRun(agentId: string, runId: string): Promise<void> {
    await this.post(
      `/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/cancel`,
      {},
      DISCOVERY_TIMEOUT_MS,
    );
  }

  /**
   * Stream an autonomous run via SSE. Similar to streamAgent but uses the
   * run-specific SSE endpoint.
   */
  async *streamRun(
    agentId: string,
    runId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    yield* this.sseGet(
      `/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/stream`,
      signal,
    );
  }

  // ── Internal HTTP helpers ──────────────────────────────────────

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.token}`,
    };
  }

  private async get<T>(path: string, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: this.headers(),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`GET ${path} failed (${resp.status}): ${text}`);
      }
      return (await resp.json()) as T;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`GET ${path} timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private async post<T>(path: string, body: object, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`POST ${path} failed (${resp.status}): ${text}`);
      }
      return (await resp.json()) as T;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`POST ${path} timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Consume an SSE stream from a POST endpoint. Uses eventsource-parser
   * to handle the text/event-stream format.
   */
  private async *ssePost(
    path: string,
    body: object,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const controller = new AbortController();
    const combinedSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;

    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        ...this.headers(),
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: combinedSignal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`SSE POST ${path} failed (${resp.status}): ${text}`);
    }

    yield* this.consumeSse(resp);
  }

  /**
   * Consume an SSE stream from a GET endpoint.
   */
  private async *sseGet(
    path: string,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const controller = new AbortController();
    const combinedSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;

    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: {
        ...this.headers(),
        Accept: 'text/event-stream',
      },
      signal: combinedSignal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`SSE GET ${path} failed (${resp.status}): ${text}`);
    }

    yield* this.consumeSse(resp);
  }

  /**
   * Parse an SSE response body into StreamEvent objects.
   */
  private async *consumeSse(resp: Response): AsyncGenerator<StreamEvent> {
    const body = resp.body;
    if (!body) return;

    // Buffer for events parsed by eventsource-parser
    const events: StreamEvent[] = [];
    let done = false;

    const parser = createParser({
      onEvent(event: EventSourceMessage) {
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(event.data);
        } catch {
          data = { raw: event.data };
        }
        events.push({ event: event.event || 'message', data });
      },
    });

    const reader = body.getReader();
    const decoder = new TextDecoder();

    try {
      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;

        if (value) {
          parser.feed(decoder.decode(value, { stream: !done }));
        }

        // Yield any buffered events
        while (events.length > 0) {
          yield events.shift()!;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
