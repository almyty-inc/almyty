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

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'timeout']);

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

  // ── Workflow invocation ───────────────────────���─────────────────

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
