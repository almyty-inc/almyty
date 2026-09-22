/**
 * Shared HTTP client for the almyty REST API.
 *
 * Used by @almyty/agents, @almyty/chat, @almyty/acp-server,
 * and @almyty/mcp-server. Covers agent discovery, invocation,
 * autonomous run management, and polling.
 */

export interface AgentTool {
  id: string;
  name: string;
  description?: string;
}

export interface AgentInfo {
  id: string;
  name: string;
  slug?: string;
  description?: string;
  mode?: 'workflow' | 'autonomous';
  status?: string;
  pipeline?: { nodes?: PipelineNode[] };
  modelConfig?: Record<string, unknown>;
  tools?: AgentTool[];
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

// ── Runners & coding sessions ───────────────────────────────────

/** A coding CLI detected on a runner machine. */
export interface RunnerCodingAgent {
  id: string;
  displayName: string;
  binary: string;
  version?: string;
  providerFamily?: string;
}

/** A registered runner (one of the user's machines). */
export interface RunnerSummary {
  id: string;
  name: string;
  state?: string;
  labels?: Record<string, string>;
  /** Coding CLIs the runner reported at registration. */
  codingAgents: RunnerCodingAgent[];
}

/** A coding session running on a runner. */
export interface CodingSession {
  sessionId: string;
  agent: string;
  binary?: string;
  processId?: string;
  cwd?: string;
  task?: string;
  status?: string;
  exitCode?: number | null;
}

/** Callback for stream events. */
export type StreamEventHandler = (event: StreamEvent) => void;

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'timeout']);
const TERMINAL_EVENT_TYPES = new Set([
  'run.completed',
  'run.failed',
  'run.cancelled',
  'coding.exit',
  // The workflow pipeline stream's own terminators.
  'execution.completed',
  'execution.failed',
  'done',
]);

/** Whether a rejection is a caller-requested abort rather than a failure. */
export function isAbortError(err: unknown): boolean {
  const e = err as { name?: string; code?: string } | null;
  return !!e && (e.name === 'AbortError' || e.code === 'ABORT_ERR');
}

/**
 * Turn one SSE frame's lines into a StreamEvent, or null when the frame
 * carries nothing usable (a keep-alive comment, or malformed JSON).
 *
 * Server frames are not uniform. Run events arrive wrapped as
 * `{type, data, timestamp}`; coding and pipeline events put their
 * fields at the top level and may also carry a `data` object. So the
 * envelope's own `data` object is flattened onto the result and the
 * top-level fields are kept. Reading `event.data.content` off an
 * `llm.chunk` returned undefined before this, which is why a streaming
 * reply used to arrive as one block once the run had already finished.
 */
export function parseSseFrame(lines: string[]): StreamEvent | null {
  let eventType = 'message';
  const dataLines: string[] = [];

  for (const line of lines) {
    // A line starting with ':' is a comment. The server sends
    // ': keep-alive' every 15s on the coding stream.
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      eventType = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      const value = line.slice(5);
      dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
    }
  }

  if (!dataLines.length) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(dataLines.join('\n'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const envelope = parsed as Record<string, unknown>;
  const inner = envelope.data;
  const flat =
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? { ...envelope, ...(inner as Record<string, unknown>) }
      : envelope;

  return {
    type: typeof envelope.type === 'string' ? envelope.type : eventType,
    data: flat,
  };
}

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
    let res: Response;
    try {
      res = await fetch(url, { ...init, headers });
    } catch (err: any) {
      // A transport failure carries no status, so callers that want to
      // say something useful about it need the cause and the host.
      throw Object.assign(new Error(err?.message || 'Network request failed'), {
        url,
        cause: err,
        networkError: true,
      });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // Status and body ride on the error. A CLI cannot turn
      // "API error 400: {...}" into a sentence a user can act on without
      // them, and parsing the message string back apart is worse.
      throw Object.assign(
        new Error(
          res.status === 401
            ? 'Authentication failed. Run: npx @almyty/auth login'
            : `API error ${res.status}: ${text}`,
        ),
        { status: res.status, body: text, url },
      );
    }
    if (res.status === 204) return null;
    return res.json();
  }

  /**
   * Connect to an SSE endpoint and call handler for each event.
   * Returns when the stream ends or a terminal event is received.
   *
   * `init` lets a caller POST (the workflow pipeline stream does);
   * omitted, this is a GET.
   */
  async streamSSE(
    path: string,
    handler: StreamEventHandler,
    signal?: AbortSignal,
    init: RequestInit = {},
  ): Promise<void> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      ...init,
      headers: { ...this.headers(), Accept: 'text/event-stream', ...((init.headers as Record<string, string>) || {}) },
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw Object.assign(new Error(`SSE ${res.status}: ${text}`), {
        status: res.status,
        body: text,
        url,
      });
    }
    const body = res.body;
    if (!body) return;

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // Frame state lives outside the read loop. It used to be declared
    // per chunk, so any frame whose terminating blank line arrived in
    // the next chunk was dropped -- which is most of them on a busy
    // stream, and is why streamed tokens never reached the CLI.
    let frame: string[] = [];

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let nl = buffer.indexOf('\n');
        while (nl !== -1) {
          // CRLF is legal in SSE and a proxy may rewrite to it. Without
          // stripping the carriage return, no line ever compares equal
          // to '' and not one frame is ever dispatched.
          const line = buffer.slice(0, nl).replace(/\r$/, '');
          buffer = buffer.slice(nl + 1);
          if (line === '') {
            const event = parseSseFrame(frame);
            frame = [];
            if (event) {
              handler(event);
              if (TERMINAL_EVENT_TYPES.has(event.type)) return;
            }
          } else {
            frame.push(line);
          }
          nl = buffer.indexOf('\n');
        }
      }
      // A server that closes without a trailing blank line still sent a
      // frame worth reading.
      if (buffer) frame.push(buffer.replace(/\r$/, ''));
      const tail = parseSseFrame(frame);
      if (tail) handler(tail);
    } finally {
      // Releasing the lock does not close the connection. A terminal
      // event returns from the loop above with the body unread and the
      // socket still open, and an SSE endpoint holds its end open too,
      // so the handle keeps Node's event loop alive: `almyty chat` would
      // not exit after a streamed turn, and a REPL leaked one connection
      // per answer. Cancelling the body is what actually closes it.
      await reader.cancel().catch(() => undefined);
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

  // ── Runners & coding sessions ───────────────────────────────────

  /** The caller's registered runners, with their detected coding CLIs. */
  async listRunners(): Promise<RunnerSummary[]> {
    const data: any = await this.request('/runners');
    const list = data?.data ?? data ?? [];
    return (list as any[]).map((r) => ({
      id: r.id,
      name: r.name,
      state: r.state,
      labels: r.labels,
      codingAgents: r.runtimeInfo?.codingAgents ?? [],
    }));
  }

  /** Fresh probe of coding CLIs installed on the runner machine. */
  async listRunnerCodingAgents(runnerId: string): Promise<RunnerCodingAgent[]> {
    const data: any = await this.request(
      `/runners/${encodeURIComponent(runnerId)}/coding/agents`,
    );
    return this.unwrap(data)?.agents ?? [];
  }

  /** Start a coding session (spawns the CLI with the task prompt). */
  async startCodingSession(
    runnerId: string,
    options: { agent: string; task: string; cwd?: string; model?: string },
  ): Promise<CodingSession> {
    const data: any = await this.request(
      `/runners/${encodeURIComponent(runnerId)}/coding/sessions`,
      { method: 'POST', body: JSON.stringify(options) },
    );
    return this.unwrap(data) as CodingSession;
  }

  async getCodingSession(runnerId: string, sessionId: string): Promise<CodingSession> {
    const data: any = await this.request(
      `/runners/${encodeURIComponent(runnerId)}/coding/sessions/${encodeURIComponent(sessionId)}`,
    );
    return this.unwrap(data) as CodingSession;
  }

  /** Route a line of user input to the session's stdin. */
  async sendCodingInput(runnerId: string, sessionId: string, data: string): Promise<void> {
    await this.request(
      `/runners/${encodeURIComponent(runnerId)}/coding/sessions/${encodeURIComponent(sessionId)}/input`,
      { method: 'POST', body: JSON.stringify({ data }) },
    );
  }

  async stopCodingSession(runnerId: string, sessionId: string, force = false): Promise<void> {
    await this.request(
      `/runners/${encodeURIComponent(runnerId)}/coding/sessions/${encodeURIComponent(sessionId)}/stop`,
      { method: 'POST', body: JSON.stringify(force ? { force } : {}) },
    );
  }

  /**
   * Stream a coding session's output via SSE. Calls handler for each
   * coding.output / coding.exit event; returns when the session exits or
   * the stream ends.
   */
  async streamCodingEvents(
    runnerId: string,
    sessionId: string,
    handler: StreamEventHandler,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.streamSSE(
      `/runners/${encodeURIComponent(runnerId)}/coding/sessions/${encodeURIComponent(sessionId)}/events`,
      handler,
      signal,
    );
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
      totalCost: run.totalCost,
      totalTokens: run.totalTokens,
    };
  }

  async getRun(runId: string): Promise<AgentRun> {
    const data = await this.client.request(`${this.prefix}/runs/${encodeURIComponent(runId)}`);
    return (data?.data ?? data) as AgentRun;
  }

  /**
   * Stream a workflow agent's pipeline as it executes.
   *
   * The unified endpoint answers POST /:org/:agent/stream with SSE:
   * execution.started, node.started, node.output, node.completed,
   * node.skipped, then execution.completed or execution.failed. Without
   * this a multi-node pipeline is a blocking POST with nothing to show
   * while it runs.
   */
  async streamInvoke(
    input: Record<string, any>,
    handler: StreamEventHandler,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.client.streamSSE(`${this.prefix}/stream`, handler, signal, {
      method: 'POST',
      body: JSON.stringify({ input }),
    });
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
    } catch (err) {
      // An abort is what the caller asked for, not a transport failure.
      // Falling back to polling here kept a cancelled run under watch
      // for the full five-minute poll window.
      if (signal?.aborted || isAbortError(err)) throw err;
      // SSE failed — fall back to polling until completion
      return this.pollRun(runId, { signal });
    }
  }

  async getConversationMessages(conversationId: string): Promise<Array<{ id: string; role: string; content: string; createdAt: string }>> {
    const data = await this.client.request(`${this.prefix}/conversations/${encodeURIComponent(conversationId)}/messages`);
    return data?.data ?? [];
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

  /**
   * Cancel a workflow execution.
   *
   * The workflow counterpart of cancelRun. A workflow run is an execution,
   * not a run, so cancelRun could never stop one -- a Ctrl-C that did not
   * also drop the SSE connection left the pipeline running and billing.
   */
  async cancelExecution(executionId: string): Promise<void> {
    await this.client.request(
      `${this.prefix}/executions/${encodeURIComponent(executionId)}/cancel`,
      { method: 'POST' },
    );
  }

  async pollRun(
    runId: string,
    options: {
      intervalMs?: number;
      timeoutMs?: number;
      onStep?: (run: AgentRun) => void;
      signal?: AbortSignal;
    } = {},
  ): Promise<AgentRun> {
    const intervalMs = options.intervalMs ?? 1500;
    const timeoutMs = options.timeoutMs ?? 5 * 60_000;
    const deadline = Date.now() + timeoutMs;
    let lastStepCount = -1;

    while (Date.now() < deadline) {
      if (options.signal?.aborted) {
        throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
      }
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
    throw Object.assign(
      new Error(`Run ${runId} did not finish within ${Math.round(timeoutMs / 1000)}s`),
      { runId, pollTimeout: true },
    );
  }
}
