/**
 * HTTP proxy to the almyty backend.
 * Fetches tools and executes tool calls via the MCP JSON-RPC API.
 *
 * Upstream, the proxy is an MCP client of almyty's own protocol core. It
 * speaks MCP 2026-07-28 there by default: every request names its version,
 * capabilities and client in `_meta` and mirrors them in the
 * `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers. An almyty
 * backend from before 2026-07-28 refuses that version with a 400; the proxy
 * then switches to the request shape it always sent (no version header,
 * no `_meta`) and stays there for the life of the process. `skills/list` is
 * almyty's own method, which the 2026-07-28 core does not serve, so it is
 * always asked the legacy way.
 *
 * ALMYTY_MCP_PROTOCOL pins the choice: `modern`, `legacy`, or `auto`
 * (default).
 */

export interface McpToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  icons?: unknown[];
}

/** A tools/call result as the upstream returned it, without the 2026 envelope fields. */
export interface UpstreamToolResult {
  content: any[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** Which protocol era the proxy speaks upstream. */
export type UpstreamEra = 'auto' | 'modern' | 'legacy';

export const MODERN_PROTOCOL_VERSION = '2026-07-28';

/** ALMYTY_MCP_PROTOCOL, read leniently: anything unknown is `auto`. */
export function upstreamEraFromEnv(value: string | undefined = process.env.ALMYTY_MCP_PROTOCOL): UpstreamEra {
  const v = (value ?? '').trim().toLowerCase();
  return v === 'modern' || v === 'legacy' ? v : 'auto';
}

/**
 * A header value as MCP 2026-07-28 carries it: as is when it is plain
 * printable ASCII with no surrounding whitespace, otherwise the Base64
 * sentinel `=?base64?...?=` of its UTF-8 bytes.
 */
export function encodeMcpHeaderValue(value: string): string {
  const plain = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(value) && !value.startsWith('=?base64?');
  return plain ? value : `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Methods whose `Mcp-Name` header mirrors a body field. */
const NAME_FIELD: Record<string, string> = { 'tools/call': 'name', 'prompts/get': 'name', 'resources/read': 'uri' };

/** Methods almyty serves only to legacy requests (its own, not in the 2026-07-28 method table). */
const LEGACY_ONLY_METHODS = new Set(['skills/list']);

/**
 * Whether an answer to a modern request says "this server does not speak
 * 2026-07-28": the 400 a backend from before it gives an unknown
 * MCP-Protocol-Version (-32600 naming the version), or the 2026 code for it
 * (-32022).
 */
export function isEraRefusal(status: number, body: any): boolean {
  if (status !== 400) return false;
  const error = body?.error;
  if (!error || typeof error.code !== 'number') return false;
  if (error.code === -32022) return true;
  return error.code === -32600 && /protocol version/i.test(String(error.message ?? ''));
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
  /** Which protocol era to speak upstream (default: auto). */
  era?: UpstreamEra;
  /** This package's version, sent as clientInfo on modern requests. */
  clientVersion?: string;
}

interface RpcAnswer {
  ok: boolean;
  status: number;
  /** The parsed body, or null when it was not JSON. */
  body: any;
  /** The raw body text, for error messages. */
  text: string;
}

export class AlmytyProxy {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly gatewayId?: string;
  private readonly discoveryTimeoutMs: number;
  private readonly toolTimeoutMs: number;
  private readonly warn: (msg: string) => void;
  private readonly configuredEra: UpstreamEra;
  private readonly clientVersion: string;
  /** The era the upstream turned out to speak; null until a request has told. */
  private resolvedEra: 'modern' | 'legacy' | null = null;
  private requestSeq = 0;

  constructor(baseUrl: string, token: string, gatewayId?: string, options: ProxyOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.gatewayId = gatewayId;
    this.discoveryTimeoutMs = options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
    this.toolTimeoutMs = options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    // Default warning sink: stderr (stdout is reserved for the MCP protocol).
    this.warn = options.warn ?? ((m) => process.stderr.write(`[almyty mcp-server] ${m}\n`));
    this.configuredEra = options.era ?? 'auto';
    this.clientVersion = options.clientVersion ?? '0.0.0';
  }

  /** The era upstream requests are sent in now. */
  get upstreamEra(): 'modern' | 'legacy' {
    if (this.configuredEra !== 'auto') return this.configuredEra;
    return this.resolvedEra ?? 'modern';
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

  /** The body and headers of one JSON-RPC request in an era. */
  private request(method: string, params: Record<string, unknown>, era: 'modern' | 'legacy') {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.token}`,
    };
    if (era === 'legacy') {
      return { headers, body: { jsonrpc: '2.0', id: this.nextId(), method, params } };
    }
    headers['Accept'] = 'application/json, text/event-stream';
    headers['MCP-Protocol-Version'] = MODERN_PROTOCOL_VERSION;
    headers['Mcp-Method'] = method;
    const field = NAME_FIELD[method];
    if (field && typeof params[field] === 'string') headers['Mcp-Name'] = encodeMcpHeaderValue(params[field] as string);
    const meta = {
      'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_VERSION,
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': { name: '@almyty/mcp-server', version: this.clientVersion },
    };
    return { headers, body: { jsonrpc: '2.0', id: this.nextId(), method, params: { ...params, _meta: meta } } };
  }

  /**
   * One POST with an AbortSignal-based timeout. Without this, a hung
   * backend (e.g., a load-balancer black-hole) would hang the MCP server
   * indefinitely with no signal to the LLM client.
   */
  private async post(
    label: string,
    method: string,
    params: Record<string, unknown>,
    era: 'modern' | 'legacy',
    timeoutMs: number,
  ): Promise<RpcAnswer> {
    const { headers, body } = this.request(method, params, era);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(this.endpoint(), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text().catch(() => '');
      let parsed: any = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      return { ok: response.ok, status: response.status, body: parsed, text };
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        throw new Error(`almyty backend ${label} timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A JSON-RPC call upstream in the current era, falling back to legacy once
   * when the backend refuses 2026-07-28 (in `auto` mode only).
   */
  private async rpc(label: string, method: string, params: Record<string, unknown>, timeoutMs: number): Promise<RpcAnswer> {
    const era = LEGACY_ONLY_METHODS.has(method) ? 'legacy' : this.upstreamEra;
    const answer = await this.post(label, method, params, era, timeoutMs);
    if (era === 'modern' && this.configuredEra === 'auto' && isEraRefusal(answer.status, answer.body)) {
      this.resolvedEra = 'legacy';
      this.warn('the almyty backend does not speak MCP 2026-07-28 yet; using the earlier protocol');
      return this.post(label, method, params, 'legacy', timeoutMs);
    }
    if (era === 'modern' && answer.ok && this.configuredEra === 'auto') this.resolvedEra = 'modern';
    return answer;
  }

  /**
   * Fetch available tools from the almyty backend, with everything the
   * gateway says about each: title, schemas, annotations, icons.
   */
  async fetchTools(): Promise<McpToolDefinition[]> {
    const answer = await this.rpc('tools/list', 'tools/list', {}, this.discoveryTimeoutMs);
    if (!answer.ok) {
      throw new Error(`Failed to fetch tools (${answer.status}): ${answer.text}`);
    }
    const data = answer.body ?? {};
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
    let answer: RpcAnswer;
    try {
      answer = await this.rpc('skills/list', 'skills/list', { limit: 100 }, this.discoveryTimeoutMs);
    } catch (err: any) {
      // Previously this swallowed the error and returned []. Surface it
      // to stderr so users can tell the difference between "no skills
      // configured" and "skills endpoint is broken".
      this.warn(`skills/list failed: ${err?.message ?? err}`);
      return [];
    }

    if (!answer.ok) {
      this.warn(`skills/list returned HTTP ${answer.status}: ${answer.text.slice(0, 200)}`);
      return [];
    }

    const data = answer.body ?? {};
    if (data.error) {
      this.warn(`skills/list MCP error: ${data.error.message}`);
      return [];
    }
    return data.result?.skills || [];
  }

  /**
   * Execute a tool call via the almyty backend and return its result as
   * the gateway gave it: content blocks, structured content, isError.
   */
  async callToolResult(toolName: string, args: Record<string, unknown>): Promise<UpstreamToolResult> {
    const answer = await this.rpc(`tools/call ${toolName}`, 'tools/call', { name: toolName, arguments: args }, this.toolTimeoutMs);
    if (!answer.ok) {
      throw new Error(`Tool execution failed (${answer.status}): ${answer.text}`);
    }
    const data = answer.body ?? {};
    if (data.error) {
      throw new Error(`Tool error: ${data.error.message}`);
    }
    const result = data.result ?? {};
    return {
      content: Array.isArray(result.content) ? result.content : [],
      ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
      ...(typeof result.isError === 'boolean' ? { isError: result.isError } : {}),
    };
  }

  /**
   * Execute a tool call and return what the model should read: the first
   * text block (parsed when it is JSON), else the whole result.
   */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.callToolResult(toolName, args);
    const textContent = result.content.find((c: any) => c?.type === 'text');
    if (textContent?.text) {
      try {
        return JSON.parse(textContent.text);
      } catch {
        return textContent.text;
      }
    }
    return result;
  }

  // ── Management API ──────────────────────────────────────────────
  // These let LLMs control the almyty platform itself — create APIs,
  // tools, gateways, agents — not just call existing tools.

  /**
   * The REST leg, for the management tools. Same timeout discipline as the
   * JSON-RPC leg: a hung backend must not hold a tool call open forever, and
   * an abort is reported as a timeout rather than as a bare AbortError.
   *
   * almyty answers an error as `{ success: false, message }`, so that is what
   * is read first; the nested `error.message` shape is the fallback.
   */
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
      if (!resp.ok) {
        const detail = data?.message || data?.error?.message || data?.error || '';
        throw new Error(`${method} ${path} failed (${resp.status})${detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
      }
      return data;
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        throw new Error(`almyty ${method} ${path} timed out after ${Math.round(this.toolTimeoutMs / 1000)}s`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async listApis(): Promise<any> { return this.rest('GET', '/apis'); }
  async createApi(data: object): Promise<any> { return this.rest('POST', '/apis', data); }
  async importSchema(apiId: string, data: object): Promise<any> { return this.rest('POST', `/apis/${apiId}/import-schema`, data); }
  async generateTools(apiId: string): Promise<any> { return this.rest('POST', `/apis/${apiId}/generate-tools`); }
  async listTools(): Promise<any> { return this.rest('GET', '/tools'); }
  // Gateways are MCP, UTCP and Skills; an agent's channels are not listed.
  async listGateways(): Promise<any> { return this.rest('GET', '/gateways?kind=tool'); }
  async createGateway(data: object): Promise<any> { return this.rest('POST', '/gateways', data); }
  async assignToolToGateway(gatewayId: string, toolId: string): Promise<any> { return this.rest('POST', `/gateways/${gatewayId}/tools`, { toolId }); }
  async listAgents(): Promise<any> { return this.rest('GET', '/agents'); }
  async createAgent(data: object): Promise<any> { return this.rest('POST', '/agents', data); }
  async invokeAgent(agentId: string, input: object): Promise<any> { return this.rest('POST', `/agents/${agentId}/invoke`, input); }
  async listProviders(): Promise<any> { return this.rest('GET', '/llm-providers'); }
  async addProvider(data: object): Promise<any> { return this.rest('POST', '/llm-providers', data); }
}
