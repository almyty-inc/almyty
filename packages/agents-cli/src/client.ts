/**
 * Tiny HTTP client for the almyty REST API, scoped to the surface
 * needed by @almyty/agents (list / get / invoke / runs).
 */

export interface AgentInfo {
  id: string;
  name: string;
  description?: string;
  mode?: 'workflow' | 'autonomous';
  status?: string;
}

export interface AgentRun {
  id: string;
  status: string;
  output?: any;
  error?: string;
  steps?: any[];
  totalCost?: number;
  totalTokens?: number;
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'timeout']);

export class AlmytyClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  private async request(path: string, init: RequestInit = {}): Promise<any> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
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

  async listAgents(): Promise<AgentInfo[]> {
    const data: any = await this.request('/agents');
    const agents = data?.data?.data || data?.data || data || [];
    return (agents as any[]).map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      mode: a.mode,
      status: a.status,
    }));
  }

  async findAgentByNameOrId(nameOrId: string): Promise<AgentInfo | null> {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(nameOrId)) {
      try {
        const data: any = await this.request(`/agents/${nameOrId}`);
        const a = data?.data ?? data;
        if (a?.id) {
          return { id: a.id, name: a.name, description: a.description, mode: a.mode, status: a.status };
        }
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
      null
    );
  }

  async invokeAgent(agentId: string, input: Record<string, any>): Promise<any> {
    const data: any = await this.request(`/agents/${agentId}/invoke`, {
      method: 'POST',
      body: JSON.stringify({ input }),
    });
    return data?.data ?? data;
  }

  async startAgentRun(
    agentId: string,
    input: any,
    limits?: { maxSteps?: number; maxCostCents?: number; maxDurationMs?: number },
  ): Promise<AgentRun> {
    const data: any = await this.request(`/agents/${agentId}/runs`, {
      method: 'POST',
      body: JSON.stringify({ input, ...(limits || {}) }),
    });
    const run = data?.data ?? data;
    return { id: run.id, status: run.status };
  }

  async getRun(agentId: string, runId: string): Promise<AgentRun> {
    const data: any = await this.request(`/agents/${agentId}/runs/${runId}`);
    return (data?.data ?? data) as AgentRun;
  }

  async listRuns(agentId: string, page = 1, limit = 20): Promise<{ data: AgentRun[]; total: number }> {
    const data: any = await this.request(`/agents/${agentId}/runs?page=${page}&limit=${limit}`);
    return {
      data: data?.data ?? [],
      total: data?.pagination?.total ?? 0,
    };
  }

  async sendRunInput(agentId: string, runId: string, input: string): Promise<void> {
    await this.request(`/agents/${agentId}/runs/${runId}/input`, {
      method: 'POST',
      body: JSON.stringify({ input }),
    });
  }

  async cancelRun(agentId: string, runId: string): Promise<void> {
    await this.request(`/agents/${agentId}/runs/${runId}/cancel`, { method: 'POST' });
  }

  /**
   * Poll a run until it reaches a terminal status (or waiting_input).
   * Calls onStep whenever new steps appear so callers can stream output.
   */
  async pollRun(
    agentId: string,
    runId: string,
    options: { intervalMs?: number; timeoutMs?: number; onStep?: (run: AgentRun) => void } = {},
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
