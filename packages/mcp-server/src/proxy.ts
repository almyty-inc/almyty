/**
 * HTTP proxy to the almyty backend.
 * Fetches tools and executes tool calls via the MCP JSON-RPC API.
 */

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** Default timeout for backend calls (ms). Tool execution is intentionally
 * longer than discovery because the LLM may be invoking a long-running tool. */
const DEFAULT_DISCOVERY_TIMEOUT_MS = 15_000;
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

interface ProxyOptions {
  /** Override for fetch timeouts. */
  discoveryTimeoutMs?: number;
  toolTimeoutMs?: number;
  /** Optional logger for non-fatal warnings (e.g. skills/list failure). */
  warn?: (msg: string) => void;
}

export class AlmytyProxy {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly gatewayId?: string;
  private readonly discoveryTimeoutMs: number;
  private readonly toolTimeoutMs: number;
  private readonly warn: (msg: string) => void;
  private requestSeq = 0;

  constructor(baseUrl: string, token: string, gatewayId?: string, options: ProxyOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.gatewayId = gatewayId;
    this.discoveryTimeoutMs = options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
    this.toolTimeoutMs = options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    // Default warning sink: stderr (stdout is reserved for the MCP protocol).
    this.warn = options.warn ?? ((m) => process.stderr.write(`[almyty mcp-server] ${m}\n`));
  }

  private endpoint(): string {
    // Per-gateway scoping uses the GitHub-style route (/:orgSlug/:gatewaySlug),
    // which the caller must encode into ALMYTY_GATEWAY_ID as "orgSlug/gatewaySlug".
    // The unscoped route is the universal /mcp JSON-RPC endpoint.
    return this.gatewayId
      ? `${this.baseUrl}/${this.gatewayId}`
      : `${this.baseUrl}/mcp`;
  }

  private nextId(): number {
    return ++this.requestSeq;
  }

  /**
   * Wrap a fetch with an AbortSignal-based timeout. Without this, a hung
   * backend (e.g., a load-balancer black-hole) would hang the MCP server
   * indefinitely with no signal to the LLM client.
   */
  private async fetchWithTimeout(
    method: string,
    body: object,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(this.endpoint(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        throw new Error(`almyty backend ${method} timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fetch available tools from the almyty backend.
   */
  async fetchTools(): Promise<McpToolDefinition[]> {
    const response = await this.fetchWithTimeout(
      'tools/list',
      {
        jsonrpc: '2.0',
        id: this.nextId(),
        method: 'tools/list',
        params: {},
      },
      this.discoveryTimeoutMs,
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Failed to fetch tools (${response.status}): ${text}`);
    }

    const data: any = await response.json();

    if (data.error) {
      throw new Error(`MCP error: ${data.error.message}`);
    }

    return data.result?.tools || [];
  }

  /**
   * Fetch skills from the almyty backend and return as resource content.
   * Failures are logged but non-fatal — the server can still operate
   * without skills (the user just won't have prompt-based guidance).
   */
  async fetchSkills(): Promise<Array<{ name: string; content: string; toolCount: number }>> {
    let response: Response;
    try {
      response = await this.fetchWithTimeout(
        'skills/list',
        {
          jsonrpc: '2.0',
          id: this.nextId(),
          method: 'skills/list',
          params: { limit: 100 },
        },
        this.discoveryTimeoutMs,
      );
    } catch (err: any) {
      // Previously this swallowed the error and returned []. Surface it
      // to stderr so users can tell the difference between "no skills
      // configured" and "skills endpoint is broken".
      this.warn(`skills/list failed: ${err?.message ?? err}`);
      return [];
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      this.warn(`skills/list returned HTTP ${response.status}: ${text.slice(0, 200)}`);
      return [];
    }

    const data: any = await response.json().catch(() => ({}));
    if (data.error) {
      this.warn(`skills/list MCP error: ${data.error.message}`);
      return [];
    }
    return data.result?.skills || [];
  }

  /**
   * Execute a tool call via the almyty backend.
   */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const response = await this.fetchWithTimeout(
      `tools/call ${toolName}`,
      {
        jsonrpc: '2.0',
        id: this.nextId(),
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args,
        },
      },
      this.toolTimeoutMs,
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Tool execution failed (${response.status}): ${text}`);
    }

    const data: any = await response.json();

    if (data.error) {
      throw new Error(`Tool error: ${data.error.message}`);
    }

    // Extract text content from MCP response
    const content = data.result?.content;
    if (Array.isArray(content) && content.length > 0) {
      const textContent = content.find((c: any) => c.type === 'text');
      if (textContent?.text) {
        try {
          return JSON.parse(textContent.text);
        } catch {
          return textContent.text;
        }
      }
    }

    return data.result;
  }

  // ── Management API ──────────────────────────────────────────────
  // These let LLMs control the almyty platform itself — create APIs,
  // tools, gateways, agents — not just call existing tools.

  private async rest(method: string, path: string, body?: object): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.toolTimeoutMs);
    try {
      const resp = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const data: any = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data?.error?.message || `${resp.status}`);
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  async listApis(): Promise<any> { return this.rest('GET', '/apis'); }
  async createApi(data: object): Promise<any> { return this.rest('POST', '/apis', data); }
  async importSchema(apiId: string, data: object): Promise<any> { return this.rest('POST', `/apis/${apiId}/import-schema`, data); }
  async generateTools(apiId: string): Promise<any> { return this.rest('POST', `/apis/${apiId}/generate-tools`); }
  async listTools(): Promise<any> { return this.rest('GET', '/tools'); }
  async listGateways(): Promise<any> { return this.rest('GET', '/gateways'); }
  async createGateway(data: object): Promise<any> { return this.rest('POST', '/gateways', data); }
  async assignToolToGateway(gatewayId: string, toolId: string): Promise<any> { return this.rest('POST', `/gateways/${gatewayId}/tools`, { toolId }); }
  async listAgents(): Promise<any> { return this.rest('GET', '/agents'); }
  async createAgent(data: object): Promise<any> { return this.rest('POST', '/agents', data); }
  async invokeAgent(agentId: string, input: object): Promise<any> { return this.rest('POST', `/agents/${agentId}/invoke`, input); }
  async listProviders(): Promise<any> { return this.rest('GET', '/llm-providers'); }
  async addProvider(data: object): Promise<any> { return this.rest('POST', '/llm-providers', data); }
}
