import { Injectable, Logger } from '@nestjs/common';
import { validateUrl } from '../../common/security/url-validator';
import {
  ResponseTooLargeError,
  capResponse,
  outboundFailureDetail,
  ssrfSafeDispatcher,
} from '../../common/security/safe-fetch';
import { dispatcherExempting } from '../../common/security/exempt-dispatcher';
import { mcpClientSettings } from './mcp-client-settings';
import { encodeMcpHeaderValue, mcpHeaderAnnotations, mcpParamHeaders } from './mcp-client-headers';

/**
 * The MCP client that connects almyty to outside MCP servers, over
 * Streamable HTTP. fetch-based, no SDK dependency. mcp-sources sync and
 * call through it, and the connection check ("is this server reachable
 * with this key?") uses it too, so both speak to a server the same way.
 *
 * Two eras (docs/design/mcp-2026-07-28.md, "Client side"):
 *
 *  - **Modern (2026-07-28)**: no handshake. Every request carries its
 *    version, client capabilities and client info in `params._meta`, and the
 *    `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers, plus an
 *    `Mcp-Param-{Name}` header for every parameter the tool marks with
 *    `x-mcp-header`. A result has a `resultType`: `complete`, `task` (the
 *    Tasks extension, followed with tasks/get) or `input_required` (the
 *    server needs a person's input; see McpToolCallOutcome).
 *  - **Legacy (2025-11-25 and older)**: `initialize`, then
 *    `notifications/initialized`, then requests in the session
 *    (`Mcp-Session-Id`, `MCP-Protocol-Version`).
 *
 * Which era a server speaks is found out once (versioning, "Backward
 * Compatibility with Initialization-Based Versions"): a `server/discover`
 * with modern `_meta` first. A DiscoverResult, or a modern error such as
 * UnsupportedProtocolVersionError (-32022, retried with a version from its
 * `supported` list), means modern; anything else (a 4xx without a modern
 * error, a legacy "no session" or method-not-found) means legacy, and the
 * client falls back to `initialize`. The caller caches the answer
 * (`McpConnectionConfig.era`), and a cached era that stops working is probed
 * again once. MCP_CLIENT_ERA pins one era for every server.
 *
 * Not supported: stdio and the deprecated HTTP+SSE (2024-11-05) transport;
 * sampling (we do not offer a model to remote servers) and roots (answered
 * with none); resources and prompts.
 *
 * SSRF: every request URL is validated through the shared url-validator,
 * and every request goes out on the pinned dispatcher. Set
 * MCP_ALLOW_PRIVATE_URLS=true to reach in-cluster MCP servers.
 */

/** The legacy version `initialize` asks for. */
export const MCP_PROTOCOL_VERSION = '2025-11-25';
/** The modern versions this client speaks, newest first. */
export const MCP_MODERN_VERSIONS: readonly string[] = ['2026-07-28'];
/** Legacy versions a server may answer initialize with that this client accepts. */
export const MCP_LEGACY_VERSIONS: readonly string[] = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const META_CLIENT = 'io.modelcontextprotocol/clientInfo';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';
/** JSON-RPC errors only a modern server sends: header mismatch, missing capability, unsupported version. */
const MODERN_ERROR_CODES = new Set([-32020, -32021, -32022]);

const CLIENT_INFO = { name: 'almyty-mcp-client', version: '1.0.0' };

/** A tools/list page or tool result larger than this is not something to buffer. */
export const MCP_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export type McpClientErrorCode =
  | 'MCP_URL_BLOCKED'
  | 'MCP_CONNECT_FAILED'
  | 'MCP_TIMEOUT'
  | 'MCP_HTTP_ERROR'
  | 'MCP_PROTOCOL_ERROR'
  | 'MCP_REMOTE_ERROR'
  | 'MCP_RESPONSE_TOO_LARGE'
  | 'MCP_UNSUPPORTED_VERSION';

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

export type McpEra = 'modern' | 'legacy';

/** The outbound call, injectable so the connection check keeps its own pinned transport. */
export type McpFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface McpConnectionConfig {
  url: string;
  /** Extra request headers (Authorization, custom auth headers, ...). */
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** What the last connection found out: skips the era probe. */
  era?: McpEra | null;
  /** With `era`: the version to speak. */
  protocolVersion?: string | null;
  /** Replaces the default pinned fetch (the caller then owns the pin). */
  fetch?: McpFetch;
}

export interface McpRemoteTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, any>;
  outputSchema?: Record<string, any>;
  annotations?: Record<string, any>;
  icons?: Array<Record<string, any>>;
}

export interface McpInitializeInfo {
  era: McpEra;
  protocolVersion: string;
  serverInfo: { name?: string; version?: string; title?: string };
  sessionId: string | null;
  capabilities: Record<string, any>;
  instructions?: string;
}

export interface McpToolCallResult {
  content: Array<Record<string, any>>;
  /** Any JSON value from 2026-07-28 on; an object before. */
  structuredContent?: unknown;
  isError?: boolean;
}

/** Requests a remote server needs answered before it can finish a call (MRTR `InputRequests`). */
export type McpInputRequests = Record<string, { method: string; params?: Record<string, any> }>;

/**
 * What a tools/call came back with: a result, or a request for input. A
 * request for input is the server's question to a person (an elicitation),
 * to be answered by calling again with `inputResponses` and the echoed
 * `requestState` -- or, when the call became a task, by tasks/update on
 * `taskId`. Requests the client can answer itself (roots: none) are
 * answered before this is returned.
 */
export type McpToolCallOutcome =
  | { kind: 'result'; result: McpToolCallResult }
  | { kind: 'input_required'; inputRequests: McpInputRequests; requestState?: string; taskId?: string };

export interface McpCallOptions {
  /** The tool as the server listed it: its `x-mcp-header` parameters become headers. */
  tool?: Pick<McpRemoteTool, 'inputSchema'>;
  /** Declare form elicitation: whoever called can put the server's question to a person. */
  canElicit?: boolean;
  /** A retry of an earlier input_required: the answers, and the state it carried. */
  inputResponses?: Record<string, unknown>;
  requestState?: string;
  /** Answer a task that waits for input (tasks/update), then follow it. */
  taskId?: string;
}

interface McpSession {
  era: McpEra;
  sessionId: string | null;
  protocolVersion: string;
}

interface Exchange {
  status: number;
  ok: boolean;
  message: { result?: any; error?: any } | null;
  sessionId: string | null;
  bodyText: string;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

@Injectable()
export class McpClientService {
  private readonly logger = new Logger(McpClientService.name);
  private nextId = 1;

  // ─── connecting ──────────────────────────────────────────────────

  /**
   * Find out how to talk to the server: the cached era when the caller has
   * one, else the server/discover probe with an initialize fallback.
   */
  async connect(config: McpConnectionConfig): Promise<McpInitializeInfo> {
    const pinned = mcpClientSettings().era;
    if (pinned === 'legacy') return this.initialize(config);
    if (config.era === 'legacy' && pinned === 'auto') return this.initialize(config);
    if (config.era === 'modern' && config.protocolVersion && MCP_MODERN_VERSIONS.includes(config.protocolVersion)) {
      return { era: 'modern', protocolVersion: config.protocolVersion, serverInfo: {}, sessionId: null, capabilities: {} };
    }
    return this.discover(config, pinned === 'modern');
  }

  /**
   * The modern probe. Returns what the server said about itself, or falls
   * back to initialize when the answer is not a modern one (unless the
   * modern era is pinned, which makes a legacy server an error).
   */
  private async discover(config: McpConnectionConfig, modernOnly: boolean): Promise<McpInitializeInfo> {
    let version = MCP_MODERN_VERSIONS[0];
    const tried = new Set<string>();
    for (;;) {
      tried.add(version);
      const session: McpSession = { era: 'modern', sessionId: null, protocolVersion: version };
      const ex = await this.exchange(config, 'server/discover', {}, session);
      const result = ex.message?.result;
      if (ex.ok && isPlainObject(result) && Array.isArray(result.supportedVersions)) {
        const serverInfo = isPlainObject(result._meta?.[META_SERVER_INFO]) ? result._meta[META_SERVER_INFO] : {};
        return {
          era: 'modern',
          protocolVersion: version,
          serverInfo,
          sessionId: null,
          capabilities: isPlainObject(result.capabilities) ? result.capabilities : {},
          ...(typeof result.instructions === 'string' ? { instructions: result.instructions } : {}),
        };
      }
      const error = ex.message?.error;
      if (error && MODERN_ERROR_CODES.has(error.code)) {
        if (error.code === -32022) {
          const supported: unknown[] = Array.isArray(error.data?.supported) ? error.data.supported : [];
          const next = MCP_MODERN_VERSIONS.find((v) => supported.includes(v) && !tried.has(v));
          if (next) {
            version = next;
            continue;
          }
          // A dual-era server that speaks none of our modern versions still
          // answers initialize; a modern-only one has nothing for us.
          if (!modernOnly && supported.some((v) => typeof v === 'string' && MCP_LEGACY_VERSIONS.includes(v))) break;
          throw new McpClientError(
            'MCP_UNSUPPORTED_VERSION',
            `MCP server at ${config.url} speaks ${supported.join(', ') || 'no version we know'}; this client speaks ${[...MCP_MODERN_VERSIONS, ...MCP_LEGACY_VERSIONS].join(', ')}`,
            { supported },
          );
        }
        throw new McpClientError('MCP_PROTOCOL_ERROR', `MCP server refused server/discover: ${error.message ?? error.code}`, { code: error.code, data: error.data });
      }
      break;
    }
    if (modernOnly) {
      throw new McpClientError('MCP_PROTOCOL_ERROR', `MCP server at ${config.url} did not answer server/discover, and MCP_CLIENT_ERA=modern`);
    }
    return this.initialize(config);
  }

  /**
   * The legacy handshake: initialize, then notifications/initialized.
   * Returns the negotiated version and the session id.
   */
  async initialize(config: McpConnectionConfig): Promise<McpInitializeInfo> {
    const { message, sessionId } = await this.request(config, 'initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    }, null);

    const result = message.result ?? {};
    const negotiated = typeof result.protocolVersion === 'string' ? result.protocolVersion : MCP_PROTOCOL_VERSION;
    const session: McpSession = { era: 'legacy', sessionId, protocolVersion: negotiated };

    // Spec: client MUST send notifications/initialized after the
    // handshake. Best-effort: some stateless servers 405/202 this.
    try {
      await this.notify(config, 'notifications/initialized', session);
    } catch (err: any) {
      this.logger.debug(`notifications/initialized not accepted by ${config.url}: ${err.message}`);
    }

    return {
      era: 'legacy',
      protocolVersion: negotiated,
      serverInfo: result.serverInfo ?? {},
      sessionId,
      capabilities: result.capabilities ?? {},
      ...(typeof result.instructions === 'string' ? { instructions: result.instructions } : {}),
    };
  }

  /**
   * Run `work` on a connection, probing again once when a cached era turns
   * out to be wrong (the server was upgraded or downgraded since).
   */
  private async withConnection<T>(
    config: McpConnectionConfig,
    work: (init: McpInitializeInfo, session: McpSession) => Promise<T>,
  ): Promise<{ value: T; init: McpInitializeInfo }> {
    const init = await this.connect(config);
    try {
      return { value: await work(init, { era: init.era, sessionId: init.sessionId, protocolVersion: init.protocolVersion }), init };
    } catch (err) {
      if (!config.era || !this.eraMismatch(err, init.era)) throw err;
      this.logger.warn(`MCP server at ${config.url} no longer speaks the cached ${init.era} era; probing again`);
      const fresh = await this.connect({ ...config, era: null, protocolVersion: null });
      return { value: await work(fresh, { era: fresh.era, sessionId: fresh.sessionId, protocolVersion: fresh.protocolVersion }), init: fresh };
    }
  }

  /** A failure that says the server speaks another era than the one we used. */
  private eraMismatch(err: unknown, era: McpEra): boolean {
    if (!(err instanceof McpClientError)) return false;
    const code = err.data?.code;
    if (era === 'modern') {
      // A legacy server: a 4xx without a modern error, or "method not found" for a modern method.
      if (err.code === 'MCP_HTTP_ERROR') return err.data?.status >= 400 && err.data?.status < 500 && !MODERN_ERROR_CODES.has(err.data?.rpcCode);
      return err.code === 'MCP_REMOTE_ERROR' && code === -32601;
    }
    // A modern-only server refusing initialize.
    return (err.code === 'MCP_REMOTE_ERROR' || err.code === 'MCP_HTTP_ERROR') && MODERN_ERROR_CODES.has(code ?? err.data?.rpcCode);
  }

  // ─── tools ───────────────────────────────────────────────────────

  /**
   * Connect, then tools/list (following pagination cursors). A tool whose
   * `x-mcp-header` annotations break the rules is left out, as the spec
   * requires, and named in `rejected`.
   */
  async listTools(
    config: McpConnectionConfig,
  ): Promise<{ tools: McpRemoteTool[]; init: McpInitializeInfo; rejected: Array<{ name: string; reason: string }> }> {
    const rejected: Array<{ name: string; reason: string }> = [];
    const { value: tools, init } = await this.withConnection(config, async (_init, session) => {
      const out: McpRemoteTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < mcpClientSettings().maxToolPages; page++) {
        const { message } = await this.request(config, 'tools/list', cursor ? { cursor } : {}, session);
        const result = message.result ?? {};
        if (!Array.isArray(result.tools)) {
          throw new McpClientError('MCP_PROTOCOL_ERROR', 'tools/list result did not contain a tools array');
        }
        for (const t of result.tools) {
          if (!t || typeof t.name !== 'string') continue;
          const headers = mcpHeaderAnnotations(t.inputSchema);
          if ('invalid' in headers) {
            this.logger.warn(`MCP server at ${config.url}: tool '${t.name}' left out: ${headers.invalid}`);
            rejected.push({ name: t.name, reason: headers.invalid });
            continue;
          }
          out.push(this.remoteTool(t));
        }
        if (typeof result.nextCursor === 'string' && result.nextCursor.length > 0) cursor = result.nextCursor;
        else break;
      }
      return out;
    });
    return { tools, init, rejected };
  }

  private remoteTool(t: any): McpRemoteTool {
    const tool: McpRemoteTool = { name: t.name };
    if (typeof t.title === 'string' && t.title.trim()) tool.title = t.title.trim().slice(0, 200);
    if (typeof t.description === 'string') tool.description = t.description;
    if (isPlainObject(t.inputSchema)) tool.inputSchema = t.inputSchema;
    if (isPlainObject(t.outputSchema)) tool.outputSchema = t.outputSchema;
    if (isPlainObject(t.annotations)) tool.annotations = t.annotations;
    if (Array.isArray(t.icons)) tool.icons = t.icons.filter(isPlainObject).slice(0, 8);
    return tool;
  }

  /**
   * tools/call, for a caller that cannot put a question to a person: a
   * remote that needs input comes back as a tool error saying so.
   */
  async callTool(
    config: McpConnectionConfig,
    name: string,
    args: Record<string, any>,
    options: McpCallOptions = {},
  ): Promise<McpToolCallResult> {
    const { outcome } = await this.callToolOutcome(config, name, args, { ...options, canElicit: false });
    if (outcome.kind === 'result') return outcome.result;
    return { content: [{ type: 'text', text: describeInputRequired(outcome.inputRequests) }], isError: true };
  }

  /**
   * tools/call with everything a 2026 server may answer: a result, a task
   * (followed with tasks/get until it ends, within MCP_CLIENT_TASK_DEADLINE_MS
   * and the caller's signal, and cancelled when either runs out), or a
   * request for input. roots/list is answered with no roots and the call
   * retried; sampling is refused (a tool error); an elicitation comes back
   * to the caller as `input_required`.
   *
   * Legacy servers get one fresh handshake per call, which keeps the client
   * correct against stateful and stateless servers alike.
   */
  async callToolOutcome(
    config: McpConnectionConfig,
    name: string,
    args: Record<string, any>,
    options: McpCallOptions = {},
  ): Promise<{ outcome: McpToolCallOutcome; init: McpInitializeInfo }> {
    const { value, init } = await this.withConnection(config, async (_init, session) => {
      if (options.taskId) {
        if (session.era !== 'modern') throw new McpClientError('MCP_PROTOCOL_ERROR', 'A task can only be answered on a 2026-07-28 server');
        await this.request(config, 'tasks/update', { taskId: options.taskId, inputResponses: options.inputResponses ?? {} }, session, { canElicit: options.canElicit });
        return this.followTask(config, session, options.taskId, undefined, options);
      }
      let inputResponses = options.inputResponses;
      let requestState = options.requestState;
      for (let round = 0; ; round++) {
        const params: Record<string, any> = { name, arguments: args };
        if (session.era === 'modern') {
          if (inputResponses) params.inputResponses = inputResponses;
          if (requestState !== undefined) params.requestState = requestState;
        }
        const extraHeaders = session.era === 'modern' ? mcpParamHeaders(options.tool?.inputSchema, args) : {};
        let message: { result?: any; error?: any };
        try {
          ({ message } = await this.request(config, 'tools/call', params, session, { canElicit: options.canElicit, extraHeaders }));
        } catch (err) {
          // MissingRequiredClientCapability: the tool needs something this
          // call did not declare (elicitation where nobody can be asked).
          // That is the tool's answer, not a broken connection.
          const missing = missingCapability(err);
          if (missing) return { kind: 'result', result: { content: [{ type: 'text', text: missing }], isError: true } } as McpToolCallOutcome;
          throw err;
        }
        const result = message.result;
        if (!isPlainObject(result)) throw new McpClientError('MCP_PROTOCOL_ERROR', 'tools/call returned no result object');
        if (result.resultType === 'task') {
          if (typeof result.taskId !== 'string' || !result.taskId) throw new McpClientError('MCP_PROTOCOL_ERROR', 'tools/call answered a task without a taskId');
          return this.followTask(config, session, result.taskId, result.pollIntervalMs, options);
        }
        if (result.resultType === 'input_required') {
          const inputRequests: McpInputRequests = isPlainObject(result.inputRequests) ? result.inputRequests : {};
          const auto = this.answerItself(inputRequests);
          if (auto.refusal) return { kind: 'result', result: { content: [{ type: 'text', text: auto.refusal }], isError: true } } as McpToolCallOutcome;
          if (auto.answered && round < mcpClientSettings().inputRounds) {
            inputResponses = { ...(inputResponses ?? {}), ...auto.answered };
            requestState = typeof result.requestState === 'string' ? result.requestState : undefined;
            continue;
          }
          return {
            kind: 'input_required',
            inputRequests,
            ...(typeof result.requestState === 'string' ? { requestState: result.requestState } : {}),
          } as McpToolCallOutcome;
        }
        return { kind: 'result', result: toToolResult(result) } as McpToolCallOutcome;
      }
    });
    return { outcome: value, init };
  }

  /**
   * What the client answers without a person: roots/list (none). Sampling
   * is refused: almyty does not lend its models to remote servers. Anything
   * else is left for the caller; `answered` is set only when every request
   * could be answered here.
   */
  private answerItself(inputRequests: McpInputRequests): { answered?: Record<string, unknown>; refusal?: string } {
    const answered: Record<string, unknown> = {};
    for (const [key, request] of Object.entries(inputRequests)) {
      if (request?.method === 'sampling/createMessage') {
        return { refusal: 'The MCP server asked almyty to run a model for it (sampling), which almyty does not offer. The tool could not finish.' };
      }
      if (request?.method === 'roots/list') answered[key] = { roots: [] };
      else return {};
    }
    return Object.keys(answered).length ? { answered } : {};
  }

  /** Follow a task until it ends or needs input; cancel it when the deadline or the caller's signal runs out. */
  private async followTask(
    config: McpConnectionConfig,
    session: McpSession,
    taskId: string,
    firstPollMs: unknown,
    options: McpCallOptions,
  ): Promise<McpToolCallOutcome> {
    const settings = mcpClientSettings();
    const deadline = Date.now() + settings.taskDeadlineMs;
    const clamp = (ms: unknown) =>
      Math.min(settings.taskPollMaxMs, Math.max(settings.taskPollMinMs, typeof ms === 'number' && Number.isFinite(ms) ? ms : settings.taskPollMinMs));
    let wait = clamp(firstPollMs);
    let rounds = 0;
    for (;;) {
      if (config.signal?.aborted || Date.now() + wait > deadline) {
        await this.cancelTask(config, taskId, session).catch(() => undefined);
        throw new McpClientError(
          'MCP_TIMEOUT',
          config.signal?.aborted
            ? `The remote task ${taskId} was cancelled with its call`
            : `The remote task ${taskId} did not finish within ${settings.taskDeadlineMs}ms; it was cancelled`,
        );
      }
      await sleep(wait, config.signal);
      if (config.signal?.aborted) continue;
      const { message } = await this.request(config, 'tasks/get', { taskId }, session, { canElicit: options.canElicit });
      const task = message.result;
      if (!isPlainObject(task)) throw new McpClientError('MCP_PROTOCOL_ERROR', 'tasks/get returned no task');
      wait = clamp(task.pollIntervalMs);
      switch (task.status) {
        case 'completed':
          return { kind: 'result', result: toToolResult(isPlainObject(task.result) ? task.result : {}) };
        case 'failed': {
          const error = isPlainObject(task.error) ? task.error : {};
          throw new McpClientError('MCP_REMOTE_ERROR', `The remote task failed: ${error.message ?? task.statusMessage ?? 'unknown error'}`, { code: error.code, data: error.data });
        }
        case 'cancelled':
          throw new McpClientError('MCP_REMOTE_ERROR', `The remote task was cancelled${task.statusMessage ? `: ${task.statusMessage}` : ''}`);
        case 'input_required': {
          const inputRequests: McpInputRequests = isPlainObject(task.inputRequests) ? task.inputRequests : {};
          const auto = this.answerItself(inputRequests);
          if (auto.refusal) {
            await this.cancelTask(config, taskId, session).catch(() => undefined);
            return { kind: 'result', result: { content: [{ type: 'text', text: auto.refusal }], isError: true } };
          }
          if (auto.answered && rounds++ < settings.inputRounds) {
            await this.request(config, 'tasks/update', { taskId, inputResponses: auto.answered }, session, { canElicit: options.canElicit });
            continue;
          }
          return { kind: 'input_required', inputRequests, taskId };
        }
        default:
          continue;
      }
    }
  }

  /** tasks/cancel on a modern server; best effort, the server decides whether to stop. */
  async cancelTask(config: McpConnectionConfig, taskId: string, session?: McpSession): Promise<void> {
    const s = session ?? (() => {
      const version = config.protocolVersion && MCP_MODERN_VERSIONS.includes(config.protocolVersion) ? config.protocolVersion : MCP_MODERN_VERSIONS[0];
      return { era: 'modern' as const, sessionId: null, protocolVersion: version };
    })();
    // Not on the caller's (possibly aborted) signal: the cancel has to go out.
    await this.request({ ...config, signal: undefined }, 'tasks/cancel', { taskId }, s);
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

  /** The modern request headers: version, method, name (taskId for the task methods). */
  private modernHeaders(method: string, params: Record<string, any>, session: McpSession): Record<string, string> {
    const headers: Record<string, string> = { 'MCP-Protocol-Version': session.protocolVersion, 'Mcp-Method': method };
    const name = method === 'tools/call' || method === 'prompts/get'
      ? params.name
      : method === 'resources/read'
        ? params.uri
        : method.startsWith('tasks/')
          ? params.taskId
          : undefined;
    if (typeof name === 'string') headers['Mcp-Name'] = encodeMcpHeaderValue(name);
    return headers;
  }

  private buildHeaders(config: McpConnectionConfig, session: McpSession | null, extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(config.headers ?? {}),
    };
    if (session && session.era === 'legacy') {
      headers['MCP-Protocol-Version'] = session.protocolVersion;
      if (session.sessionId) headers['Mcp-Session-Id'] = session.sessionId;
    }
    return { ...headers, ...extra };
  }

  private async post(
    config: McpConnectionConfig,
    body: Record<string, any>,
    headers: Record<string, string>,
  ): Promise<Response> {
    this.assertUrlAllowed(config.url);

    const timeoutMs = config.timeoutMs ?? mcpClientSettings().timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    const onCallerAbort = () => controller.abort(config.signal?.reason);
    config.signal?.addEventListener('abort', onCallerAbort, { once: true });
    if (config.signal?.aborted) controller.abort(config.signal.reason);

    try {
      const init = {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error', // a redirect could bounce us to a blocked host
        // Pin DNS: the string check above does not see what the name
        // resolves to. undici ignores http.Agents, so this is the
        // dispatcher. With MCP_ALLOW_PRIVATE_URLS on, the pin is relaxed
        // for this server's host only -- the hatch lets a self-hoster reach
        // an in-cluster name without unpinning every other name.
        dispatcher: process.env.MCP_ALLOW_PRIVATE_URLS === 'true'
          ? dispatcherExempting(new URL(config.url).hostname)
          : ssrfSafeDispatcher,
      } as RequestInit;
      // The body is capped: a tools/list is buffered whole (and an SSE
      // stream until our response arrives), so an endless or huge reply
      // would otherwise be read into the API process.
      const res = config.fetch ? await config.fetch(config.url, init) : await fetch(config.url, init);
      return capResponse(res, MCP_MAX_RESPONSE_BYTES);
    } catch (err: any) {
      if (controller.signal.aborted) {
        throw new McpClientError(
          'MCP_TIMEOUT',
          `MCP request to ${config.url} timed out after ${timeoutMs}ms or was cancelled`,
        );
      }
      throw new McpClientError(
        'MCP_CONNECT_FAILED',
        `Could not reach MCP server at ${config.url}: ${outboundFailureDetail(err)}`,
      );
    } finally {
      clearTimeout(timer);
      config.signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  /** Fire-and-forget JSON-RPC notification (no id, no response body). Legacy only. */
  private async notify(
    config: McpConnectionConfig,
    method: string,
    session: McpSession,
  ): Promise<void> {
    const res = await this.post(config, { jsonrpc: '2.0', method }, this.buildHeaders(config, session));
    // Drain/ignore body; 202 Accepted is the expected happy path.
    await res.text().catch(() => undefined);
    if (!res.ok && res.status !== 405) {
      throw new McpClientError('MCP_HTTP_ERROR', `notification ${method} got HTTP ${res.status}`);
    }
  }

  /**
   * Send one JSON-RPC request and read the answer, whatever the HTTP status.
   * Modern requests carry `_meta` and the modern headers; legacy ones the
   * session. Both plain-JSON and SSE framings are read.
   */
  private async exchange(
    config: McpConnectionConfig,
    method: string,
    params: Record<string, any>,
    session: McpSession | null,
    opts: { canElicit?: boolean; extraHeaders?: Record<string, string> } = {},
  ): Promise<Exchange> {
    const id = this.nextId++;
    let body: Record<string, any> = { jsonrpc: '2.0', id, method, params };
    let headers = this.buildHeaders(config, session, opts.extraHeaders);
    if (session?.era === 'modern') {
      // Tasks: followed with tasks/get. Roots: a server may ask, and gets none
      // (almyty exposes no file roots). Elicitation only where a person can answer.
      const clientCapabilities: Record<string, any> = { roots: {}, extensions: { [TASKS_EXTENSION]: {} } };
      if (opts.canElicit) clientCapabilities.elicitation = { form: {} };
      body = {
        ...body,
        params: {
          ...params,
          _meta: { [META_VERSION]: session.protocolVersion, [META_CAPABILITIES]: clientCapabilities, [META_CLIENT]: CLIENT_INFO },
        },
      };
      headers = { ...headers, ...this.modernHeaders(method, params, session) };
    }
    const res = await this.post(config, body, headers);
    const sessionId = res.headers.get('mcp-session-id') ?? session?.sessionId ?? null;

    const bodyText = await res.text().catch((err) => {
      if (err instanceof ResponseTooLargeError) {
        throw new McpClientError('MCP_RESPONSE_TOO_LARGE', `MCP server response to ${method} exceeded ${MCP_MAX_RESPONSE_BYTES} bytes`);
      }
      return '';
    });
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    let message: Exchange['message'] = null;
    try {
      message = contentType.includes('text/event-stream')
        ? this.extractSseResponse(bodyText, id)
        : this.parseJsonResponse(bodyText, id);
    } catch {
      message = null;
    }
    // A refusal before the request was read (a 400 for a bad header) has no id.
    if (!message && !res.ok) {
      try {
        const parsed = JSON.parse(bodyText);
        if (isPlainObject(parsed) && isPlainObject(parsed.error)) message = { error: parsed.error };
      } catch {
        // not JSON
      }
    }
    return { status: res.status, ok: res.ok, message, sessionId, bodyText };
  }

  /** exchange, with every failure as a typed McpClientError. */
  private async request(
    config: McpConnectionConfig,
    method: string,
    params: Record<string, any>,
    session: McpSession | null,
    opts: { canElicit?: boolean; extraHeaders?: Record<string, string> } = {},
  ): Promise<{ message: { result?: any; error?: any }; sessionId: string | null }> {
    const ex = await this.exchange(config, method, params, session, opts);
    if (!ex.ok) {
      throw new McpClientError(
        'MCP_HTTP_ERROR',
        `MCP server returned HTTP ${ex.status} for ${method}${ex.message?.error?.message ? `: ${ex.message.error.message}` : ''}`,
        { status: ex.status, body: ex.bodyText.slice(0, 2000), rpcCode: ex.message?.error?.code },
      );
    }
    if (!ex.message) {
      if (ex.bodyText.trim() && !/^\s*(\{|\[|event:|data:|:)/.test(ex.bodyText)) {
        throw new McpClientError('MCP_PROTOCOL_ERROR', 'MCP server returned a non-JSON body');
      }
      throw new McpClientError('MCP_PROTOCOL_ERROR', `MCP server sent no JSON-RPC response for ${method}`);
    }
    if (ex.message.error) {
      throw new McpClientError(
        'MCP_REMOTE_ERROR',
        `MCP server error for ${method}: ${ex.message.error.message ?? 'unknown error'}`,
        { code: ex.message.error.code, data: ex.message.error.data },
      );
    }
    return { message: ex.message, sessionId: ex.sessionId };
  }

  private parseJsonResponse(bodyText: string, id: number): { result?: any; error?: any } | null {
    const parsed = JSON.parse(bodyText);
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

/** The plain-words refusal for a -32021 (MissingRequiredClientCapability), or null for any other error. */
function missingCapability(err: unknown): string | null {
  if (!(err instanceof McpClientError)) return null;
  const code = err.data?.rpcCode ?? err.data?.code;
  if (code !== -32021) return null;
  let required: Record<string, unknown> = {};
  try {
    const body = typeof err.data?.body === 'string' ? JSON.parse(err.data.body) : null;
    required = body?.error?.data?.requiredCapabilities ?? err.data?.data?.requiredCapabilities ?? {};
  } catch {
    required = err.data?.data?.requiredCapabilities ?? {};
  }
  if ('elicitation' in required) {
    return 'The MCP server needs to ask a person something before this tool can finish, and this call cannot ask. Run the tool from an agent, which asks the person.';
  }
  const names = Object.keys(required);
  return `The MCP server needs a client capability this call does not offer${names.length ? ` (${names.join(', ')})` : ''}. The tool could not run.`;
}

function toToolResult(result: Record<string, any>): McpToolCallResult {
  return {
    content: Array.isArray(result.content) ? result.content : [],
    structuredContent: result.structuredContent !== undefined && result.structuredContent !== null ? result.structuredContent : undefined,
    isError: result.isError === true,
  };
}

/** The questions a remote asked, in words, for a caller that cannot ask a person. */
export function describeInputRequired(inputRequests: McpInputRequests): string {
  const questions = Object.values(inputRequests)
    .filter((r) => r?.method === 'elicitation/create')
    .map((r) => {
      const message = typeof r.params?.message === 'string' ? r.params.message : 'a question';
      return r.params?.mode === 'url' && typeof r.params?.url === 'string' ? `${message} (${r.params.url})` : message;
    });
  const asked = questions.length ? `: ${questions.join(' / ')}` : '';
  return `The MCP server needs input from a person before this tool can finish${asked}. This call cannot ask for it; run the tool from an agent, which asks the person, or give the server what it needs and call again.`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
