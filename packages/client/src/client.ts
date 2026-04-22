/**
 * Shared HTTP client for the almyty REST API.
 *
 * Used by @almyty/agents, @almyty/chat, @almyty/acp-server,
 * and @almyty/mcp-server. Covers agent discovery, invocation,
 * autonomous run management, and polling.
 */

export interface AgentInfo {
  id: string;
  name: string;
  slug?: string;
  description?: string;
  mode?: 'workflow' | 'autonomous';
  status?: string;
  pipeline?: { nodes?: PipelineNode[] };
  modelConfig?: Record<string, unknown>;
}

export interface PipelineNode {
  id: string;
  type: string;
  label?: string;
  config?: Record<string, unknown>;
}

export interface AgentRun {
  id: string;
  agentId?: string;
  status: string;
  conversationId?: string;
  output?: unknown;
  error?: string;
  steps?: unknown[];
  totalCost?: number;
  totalTokens?: number;
}

export interface RunLimits {
  maxSteps?: number;
  maxCostCents?: number;
  maxDurationMs?: number;
}

/** SSE event from the agent run stream. */
export interface StreamEvent {
  type: string;
  data: Record<string, unknown>;
}

/** Callback for stream events. */
export type StreamEventHandler = (event: StreamEvent) => void;

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'timeout']);
const TERMINAL_EVENT_TYPES = new Set(['run.completed', 'run.failed', 'run.cancelled']);

export class AlmytyClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  // ── HTTP helpers ────────────────────────────────────────────────

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
  }

  async request(path: string, init: RequestInit = {}): Promise<any> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      ...this.headers(),
      ...((init.headers as Record<string, string>) || {}),
    };
    const res = await fetch(url, { ...init, headers });
    if (!res.ok) {
      if (res.status === 401) {
        throw new Error('Authentication failed. Run: npx @almyty/auth login');
      }
      const text = await res.text().catch(() => '');
      throw new Error(`API error ${res.status}: ${text}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  /**
   * Connect to an SSE endpoint and call handler for each event.
   * Returns when the stream ends or a terminal event is received.
   */
  async streamSSE(path: string, handler: StreamEventHandler, signal?: AbortSignal): Promise<void> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      headers: { ...this.headers(), Accept: 'text/event-stream' },
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`SSE ${res.status}: ${text}`);
    }
    const body = res.body;
    if (!body) return;

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Parse SSE frames
        const lines = buffer.split('\n');
        buffer = lines.pop()!; // keep incomplete line
        let eventType = 'message';
        let dataLines: string[] = [];

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            dataLines.push(line.slice(6));
          } else if (line === '') {
            // End of frame
            if (dataLines.length) {
              const raw = dataLines.join('\n');
              try {
                const data = JSON.parse(raw);
                const event: StreamEvent = { type: data.type || eventType, data };
                handler(event);
                if (TERMINAL_EVENT_TYPES.has(event.type)) return;
              } catch { /* skip malformed */ }
              dataLines = [];
              eventType = 'message';
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private unwrap(data: any): any {
    return data?.data ?? data;
  }

  // ── Agent discovery ─────────────────────────────────────────────

  async listAgents(): Promise<AgentInfo[]> {
    const data: any = await this.request('/agents');
    const list = data?.data?.data || data?.data || data || [];
    return (list as any[]).map((a) => ({
      id: a.id,
      name: a.name,
      slug: a.slug,
      description: a.description,
      mode: a.mode,
      status: a.status,
      pipeline: a.pipeline,
      modelConfig: a.modelConfig,
    }));
  }

  async getAgent(id: string): Promise<AgentInfo> {
    const data = await this.request(`/agents/${encodeURIComponent(id)}`);
    return this.unwrap(data);
  }

  async findAgentByNameOrId(nameOrId: string): Promise<AgentInfo | null> {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(nameOrId)) {
      try {
        const agent = await this.getAgent(nameOrId);
        if (agent?.id) return agent;
      } catch {
        // fall through to name search
      }
    }
    const all = await this.listAgents();
    const lower = nameOrId.toLowerCase();
    return (
      all.find((a) => a.name === nameOrId) ||
      all.find((a) => a.name.toLowerCase() === lower) ||
      all.find((a) => a.name.toLowerCase().replace(/\s+/g, '-') === lower) ||
      all.find((a) => a.slug === nameOrId) ||
      all.find((a) => a.slug?.toLowerCase() === lower) ||
      null
    );
  }

  // ── Gateway-scoped client ───────────────────────────────────────

  /**
   * Return a gateway-scoped client that routes all calls through
   * /:orgSlug/:agentSlug instead of /agents/:id.
   */
  gateway(orgSlug: string, agentSlug: string): GatewayClient {
    return new GatewayClient(this, orgSlug, agentSlug);
  }

  // ── Workflow invocation ────────────────────────────────────────

  async invokeAgent(agentId: string, input: Record<string, any>): Promise<any> {
    const data = await this.request(`/agents/${encodeURIComponent(agentId)}/invoke`, {
      method: 'POST',
      body: JSON.stringify({ input }),
    });
    return this.unwrap(data);
  }

  // ── Autonomous run management ───────────────────────────────────

  async startRun(
    agentId: string,
    input: any,
    options?: RunLimits & { conversationId?: string },
  ): Promise<AgentRun> {
    const body: Record<string, any> = { input };
    if (options?.maxSteps) body.maxSteps = options.maxSteps;
    if (options?.maxCostCents) body.maxCostCents = options.maxCostCents;
    if (options?.maxDurationMs) body.maxDurationMs = options.maxDurationMs;
    if (options?.conversationId) body.conversationId = options.conversationId;

    const data = await this.request(`/agents/${encodeURIComponent(agentId)}/runs`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const run = this.unwrap(data);
    return {
      id: run.id,
      agentId: run.agentId,
      status: run.status,
      conversationId: run.conversationId,
      output: run.output,
      error: run.error,
      steps: run.steps,
      totalCost: run.totalCost,
      totalTokens: run.totalTokens,
    };
  }

  async getRun(agentId: string, runId: string): Promise<AgentRun> {
    const data = await this.request(
      `/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`,
    );
    return this.unwrap(data) as AgentRun;
  }

  async listRuns(agentId: string, page = 1, limit = 20): Promise<{ data: AgentRun[]; total: number }> {
    const data: any = await this.request(
      `/agents/${encodeURIComponent(agentId)}/runs?page=${page}&limit=${limit}`,
    );
    return {
      data: data?.data ?? [],
      total: data?.pagination?.total ?? 0,
    };
  }

  async sendRunInput(agentId: string, runId: string, input: string): Promise<void> {
    await this.request(
      `/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/input`,
      { method: 'POST', body: JSON.stringify({ input }) },
    );
  }

  async cancelRun(agentId: string, runId: string): Promise<void> {
    await this.request(
      `/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/cancel`,
      { method: 'POST' },
    );
  }

  /**
   * Poll a run until it reaches a terminal status (or waiting_input).
   */
  async pollRun(
    agentId: string,
    runId: string,
    options: {
      intervalMs?: number;
      timeoutMs?: number;
      onStep?: (run: AgentRun) => void;
    } = {},
  ): Promise<AgentRun> {
    const intervalMs = options.intervalMs ?? 1500;
    const timeoutMs = options.timeoutMs ?? 5 * 60_000;
    const deadline = Date.now() + timeoutMs;
    let lastStepCount = -1;

    while (Date.now() < deadline) {
      const run = await this.getRun(agentId, runId);
      if (Array.isArray(run.steps) && run.steps.length !== lastStepCount) {
        lastStepCount = run.steps.length;
        options.onStep?.(run);
      }
      if (run.status && (TERMINAL_STATUSES.has(run.status) || run.status === 'waiting_input')) {
        return run;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`Run ${runId} did not finish within ${Math.round(timeoutMs / 1000)}s`);
  }
}

// ── Gateway-scoped client ───────────────────────────────────────

/**
 * Routes all agent calls through the gateway unified endpoint
 * (/:orgSlug/:agentSlug/...) instead of /agents/:id/...
 *
 * Authenticates via API key (same Bearer token).
 */
export class GatewayClient {
  private readonly client: AlmytyClient;
  private readonly prefix: string;
  readonly orgSlug: string;
  readonly agentSlug: string;

  constructor(client: AlmytyClient, orgSlug: string, agentSlug: string) {
    this.client = client;
    this.orgSlug = orgSlug;
    this.agentSlug = agentSlug;
    this.prefix = `/${encodeURIComponent(orgSlug)}/${encodeURIComponent(agentSlug)}`;
  }

  async getInfo(): Promise<AgentInfo> {
    const data = await this.client.request(this.prefix);
    return data?.data ?? data;
  }

  async invoke(input: Record<string, any>): Promise<any> {
    const data = await this.client.request(`${this.prefix}/invoke`, {
      method: 'POST',
      body: JSON.stringify({ input }),
    });
    return data?.data ?? data;
  }

  async startRun(
    input: any,
    options?: RunLimits & { conversationId?: string },
  ): Promise<AgentRun> {
    const body: Record<string, any> = { input };
    if (options?.maxSteps) body.maxSteps = options.maxSteps;
    if (options?.maxCostCents) body.maxCostCents = options.maxCostCents;
    if (options?.maxDurationMs) body.maxDurationMs = options.maxDurationMs;
    if (options?.conversationId) body.conversationId = options.conversationId;

    const data = await this.client.request(`${this.prefix}/runs`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const run = data?.data ?? data;
    return {
      id: run.id,
      agentId: run.agentId,
      status: run.status,
      conversationId: run.conversationId,
      output: run.output,
      error: run.error,
      steps: run.steps,
    };
  }

  async getRun(runId: string): Promise<AgentRun> {
    const data = await this.client.request(`${this.prefix}/runs/${encodeURIComponent(runId)}`);
    return (data?.data ?? data) as AgentRun;
  }

  /**
   * Stream run events via SSE. Calls handler for each event
   * (llm.started, llm.chunk, llm.response, tool.started, tool.result,
   * step.completed, run.completed, run.failed).
   * Returns when the run completes or fails.
   * Falls back to polling if SSE fails.
   */
  async streamRun(runId: string, handler: StreamEventHandler, signal?: AbortSignal): Promise<AgentRun> {
    try {
      await this.client.streamSSE(
        `${this.prefix}/runs/${encodeURIComponent(runId)}/stream`,
        handler,
        signal,
      );
      // Stream ended — get final state
      return this.getRun(runId);
    } catch {
      // SSE failed — fall back to polling until completion
      return this.pollRun(runId);
    }
  }

  async sendRunInput(runId: string, input: string): Promise<void> {
    await this.client.request(
      `${this.prefix}/runs/${encodeURIComponent(runId)}/input`,
      { method: 'POST', body: JSON.stringify({ input }) },
    );
  }

  async cancelRun(runId: string): Promise<void> {
    await this.client.request(
      `${this.prefix}/runs/${encodeURIComponent(runId)}/cancel`,
      { method: 'POST' },
    );
  }

  async pollRun(
    runId: string,
    options: {
      intervalMs?: number;
      timeoutMs?: number;
      onStep?: (run: AgentRun) => void;
    } = {},
  ): Promise<AgentRun> {
    const intervalMs = options.intervalMs ?? 1500;
    const timeoutMs = options.timeoutMs ?? 5 * 60_000;
    const deadline = Date.now() + timeoutMs;
    let lastStepCount = -1;

    while (Date.now() < deadline) {
      const run = await this.getRun(runId);
      if (Array.isArray(run.steps) && run.steps.length !== lastStepCount) {
        lastStepCount = run.steps.length;
        options.onStep?.(run);
      }
      if (run.status && (TERMINAL_STATUSES.has(run.status) || run.status === 'waiting_input')) {
        return run;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`Run ${runId} did not finish within ${Math.round(timeoutMs / 1000)}s`);
  }
}
