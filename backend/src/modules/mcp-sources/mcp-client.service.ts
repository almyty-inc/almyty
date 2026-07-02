import { Injectable, Logger } from '@nestjs/common';
import { validateUrl } from '../../common/security/url-validator';

/**
 * Minimal MCP client over the Streamable HTTP transport
 * (spec revision 2025-03-26+). fetch-based, no SDK dependency.
 *
 * Supported:
 *   - JSON-RPC over POST: initialize / notifications/initialized /
 *     tools/list (with cursor pagination) / tools/call
 *   - Both response framings: application/json and text/event-stream
 *     (SSE events are buffered until the response for our request id
 *     arrives; the spec says the server SHOULD then close the stream)
 *   - Mcp-Session-Id header: captured from the initialize response and
 *     echoed on every subsequent request in the session
 *   - MCP-Protocol-Version header on post-initialize requests
 *
 * Not supported (deliberately out of scope for a tool source client):
 *   - stdio / legacy HTTP+SSE (2024-11-05) transports
 *   - server-initiated requests (sampling/elicitation) — SSE messages
 *     that are not the response to our request are ignored
 *   - resources / prompts / subscriptions
 *
 * SSRF: every request URL is validated through the shared
 * url-validator (private ranges, loopback, link-local, cloud metadata
 * endpoints blocked). Set MCP_ALLOW_PRIVATE_URLS=true to opt out for
 * self-hosted deployments that need to reach in-cluster MCP servers.
 */

export const MCP_PROTOCOL_VERSION = '2025-06-18';

export type McpClientErrorCode =
  | 'MCP_URL_BLOCKED'
  | 'MCP_CONNECT_FAILED'
  | 'MCP_TIMEOUT'
  | 'MCP_HTTP_ERROR'
  | 'MCP_PROTOCOL_ERROR'
  | 'MCP_REMOTE_ERROR';

export class McpClientError extends Error {
  constructor(
    public readonly code: McpClientErrorCode,
    message: string,
    public readonly data?: any,
  ) {
    super(message);
    this.name = 'McpClientError';
  }
}

export interface McpConnectionConfig {
  url: string;
  /** Extra request headers (Authorization, custom auth headers, ...). */
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface McpRemoteTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, any>;
}

export interface McpInitializeInfo {
  protocolVersion: string;
  serverInfo: { name?: string; version?: string };
  sessionId: string | null;
  capabilities: Record<string, any>;
}

export interface McpToolCallResult {
  content: Array<Record<string, any>>;
  structuredContent?: Record<string, any>;
  isError?: boolean;
}

interface McpSession {
  sessionId: string | null;
  protocolVersion: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

@Injectable()
export class McpClientService {
  private readonly logger = new Logger(McpClientService.name);
  private nextId = 1;

  /**
   * initialize handshake. Returns negotiated protocol info + session id.
   */
  async initialize(config: McpConnectionConfig): Promise<McpInitializeInfo> {
    const { message, sessionId } = await this.request(config, 'initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'almyty-mcp-client', version: '1.0.0' },
    }, null);

    const result = message.result ?? {};
    const session: McpSession = {
      sessionId,
      protocolVersion:
        typeof result.protocolVersion === 'string' ? result.protocolVersion : MCP_PROTOCOL_VERSION,
    };

    // Spec: client MUST send notifications/initialized after the
    // handshake. Best-effort — some stateless servers 405/202 this.
    try {
      await this.notify(config, 'notifications/initialized', session);
    } catch (err: any) {
      this.logger.debug(`notifications/initialized not accepted by ${config.url}: ${err.message}`);
    }

    return {
      protocolVersion: session.protocolVersion,
      serverInfo: result.serverInfo ?? {},
      sessionId,
      capabilities: result.capabilities ?? {},
    };
  }

  /**
   * initialize + tools/list (following pagination cursors).
   */
  async listTools(
    config: McpConnectionConfig,
  ): Promise<{ tools: McpRemoteTool[]; init: McpInitializeInfo }> {
    const init = await this.initialize(config);
    const session: McpSession = { sessionId: init.sessionId, protocolVersion: init.protocolVersion };

    const tools: McpRemoteTool[] = [];
    let cursor: string | undefined;
    // Hard page cap so a misbehaving server can't loop us forever.
    for (let page = 0; page < 50; page++) {
      const { message } = await this.request(
        config,
        'tools/list',
        cursor ? { cursor } : {},
        session,
      );
      const result = message.result ?? {};
      if (!Array.isArray(result.tools)) {
        throw new McpClientError(
          'MCP_PROTOCOL_ERROR',
          'tools/list result did not contain a tools array',
        );
      }
      for (const t of result.tools) {
        if (t && typeof t.name === 'string') {
          tools.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
        }
      }
      if (typeof result.nextCursor === 'string' && result.nextCursor.length > 0) {
        cursor = result.nextCursor;
      } else {
        return { tools, init };
      }
    }
    return { tools, init };
  }

  /**
   * initialize + tools/call. A fresh handshake per call keeps the
   * client correct against both stateful and stateless servers.
   */
  async callTool(
    config: McpConnectionConfig,
    name: string,
    args: Record<string, any>,
  ): Promise<McpToolCallResult> {
    const init = await this.initialize(config);
    const session: McpSession = { sessionId: init.sessionId, protocolVersion: init.protocolVersion };

    const { message } = await this.request(config, 'tools/call', { name, arguments: args }, session);
    const result = message.result;
    if (!result || typeof result !== 'object') {
      throw new McpClientError('MCP_PROTOCOL_ERROR', 'tools/call returned no result object');
    }
    return {
      content: Array.isArray(result.content) ? result.content : [],
      structuredContent:
        result.structuredContent && typeof result.structuredContent === 'object'
          ? result.structuredContent
          : undefined,
      isError: result.isError === true,
    };
  }

  // ─── transport ───────────────────────────────────────────────────

  /** Public so create-time validation can fail fast before persisting. */
  assertUrlAllowed(url: string): void {
    if (process.env.MCP_ALLOW_PRIVATE_URLS === 'true') {
      // Still require a parseable http(s) URL even when private ranges
      // are explicitly allowed.
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new McpClientError('MCP_URL_BLOCKED', `Invalid MCP server URL: ${url}`);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new McpClientError('MCP_URL_BLOCKED', `Blocked protocol: ${parsed.protocol}`);
      }
      return;
    }
    const validation = validateUrl(url);
    if (!validation.valid) {
      throw new McpClientError('MCP_URL_BLOCKED', `MCP server URL rejected: ${validation.error}`);
    }
  }

  private buildHeaders(config: McpConnectionConfig, session: McpSession | null): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(config.headers ?? {}),
    };
    if (session) {
      headers['MCP-Protocol-Version'] = session.protocolVersion;
      if (session.sessionId) {
        headers['Mcp-Session-Id'] = session.sessionId;
      }
    }
    return headers;
  }

  private async post(
    config: McpConnectionConfig,
    body: Record<string, any>,
    session: McpSession | null,
  ): Promise<Response> {
    this.assertUrlAllowed(config.url);

    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    const onCallerAbort = () => controller.abort(config.signal?.reason);
    config.signal?.addEventListener('abort', onCallerAbort, { once: true });
    if (config.signal?.aborted) controller.abort(config.signal.reason);

    try {
      return await fetch(config.url, {
        method: 'POST',
        headers: this.buildHeaders(config, session),
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error', // a redirect could bounce us to a blocked host
      });
    } catch (err: any) {
      if (controller.signal.aborted) {
        throw new McpClientError(
          'MCP_TIMEOUT',
          `MCP request to ${config.url} timed out after ${timeoutMs}ms or was cancelled`,
        );
      }
      throw new McpClientError(
        'MCP_CONNECT_FAILED',
        `Could not reach MCP server at ${config.url}: ${err?.message ?? err}`,
      );
    } finally {
      clearTimeout(timer);
      config.signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  /** Fire-and-forget JSON-RPC notification (no id, no response body). */
  private async notify(
    config: McpConnectionConfig,
    method: string,
    session: McpSession,
  ): Promise<void> {
    const res = await this.post(config, { jsonrpc: '2.0', method }, session);
    // Drain/ignore body; 202 Accepted is the expected happy path.
    await res.text().catch(() => undefined);
    if (!res.ok && res.status !== 405) {
      throw new McpClientError('MCP_HTTP_ERROR', `notification ${method} got HTTP ${res.status}`);
    }
  }

  /**
   * Send a JSON-RPC request and return the matching response message.
   * Handles both plain-JSON and SSE response framings.
   */
  private async request(
    config: McpConnectionConfig,
    method: string,
    params: Record<string, any>,
    session: McpSession | null,
  ): Promise<{ message: { result?: any; error?: any }; sessionId: string | null }> {
    const id = this.nextId++;
    const res = await this.post(config, { jsonrpc: '2.0', id, method, params }, session);
    const sessionId = res.headers.get('mcp-session-id') ?? session?.sessionId ?? null;

    const bodyText = await res.text().catch(() => '');

    if (!res.ok) {
      throw new McpClientError(
        'MCP_HTTP_ERROR',
        `MCP server returned HTTP ${res.status} for ${method}`,
        { status: res.status, body: bodyText.slice(0, 2000) },
      );
    }

    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    const message = contentType.includes('text/event-stream')
      ? this.extractSseResponse(bodyText, id)
      : this.parseJsonResponse(bodyText, id);

    if (!message) {
      throw new McpClientError(
        'MCP_PROTOCOL_ERROR',
        `MCP server sent no JSON-RPC response for ${method} (id ${id})`,
      );
    }
    if (message.error) {
      throw new McpClientError(
        'MCP_REMOTE_ERROR',
        `MCP server error for ${method}: ${message.error.message ?? 'unknown error'}`,
        { code: message.error.code, data: message.error.data },
      );
    }
    return { message, sessionId };
  }

  private parseJsonResponse(bodyText: string, id: number): { result?: any; error?: any } | null {
    let parsed: any;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      throw new McpClientError('MCP_PROTOCOL_ERROR', 'MCP server returned a non-JSON body');
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    return messages.find((m) => m && m.id === id && (m.result !== undefined || m.error !== undefined)) ?? null;
  }

  /**
   * Parse a buffered SSE stream and pick out the JSON-RPC response for
   * our request id. Non-matching messages (server notifications,
   * server-initiated requests) are ignored.
   */
  private extractSseResponse(bodyText: string, id: number): { result?: any; error?: any } | null {
    for (const rawEvent of bodyText.split(/\r?\n\r?\n/)) {
      const dataLines = rawEvent
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart());
      if (dataLines.length === 0) continue;
      try {
        const msg = JSON.parse(dataLines.join('\n'));
        if (msg && msg.id === id && (msg.result !== undefined || msg.error !== undefined)) {
          return msg;
        }
      } catch {
        // Ignore non-JSON SSE events (comments, keepalives).
      }
    }
    return null;
  }
}
