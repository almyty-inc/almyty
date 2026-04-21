/**
 * AlmytyAcpAgent: handles all ACP JSON-RPC methods.
 *
 * Bridges the ACP protocol to the almyty backend REST API. Manages
 * session lifecycle, dispatches prompts to the correct execution engine,
 * and streams SessionUpdate notifications back to the client.
 */

import type { AlmytyProxy, AgentInfo, AgentRun } from './proxy.js';
import { SessionManager, type Session } from './session.js';
import {
  mapStreamEvent,
  buildPlanFromPipeline,
  isTerminalEvent,
  extractFinalOutput,
  type SessionUpdate,
  type SessionUpdatePayload,
} from './events.js';

// ── ACP JSON-RPC types ───────────────────────────────────────────

/** JSON-RPC 2.0 request. */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 response. */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** JSON-RPC 2.0 notification (no id). */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcMessage = JsonRpcResponse | JsonRpcNotification;

/** Callback for sending messages to the ACP client. */
export type SendFn = (msg: JsonRpcMessage) => void;

/** ACP ContentBlock from the prompt request. */
interface ContentBlock {
  type: 'text' | 'image' | 'audio' | 'resource_link' | 'resource';
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
}

/** ACP PromptResponse. */
interface PromptResponse {
  stopReason: 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';
  content?: ContentBlock[];
}

/** ACP initialize result. */
interface InitializeResult {
  protocolVersion: number;
  agentCapabilities: {
    tools?: boolean;
    streaming?: boolean;
    sessions?: boolean;
    sessionList?: boolean;
    plan?: boolean;
    modes?: boolean;
  };
  authMethods: AuthMethod[];
  agentInfo?: {
    name: string;
    description?: string;
  };
}

interface AuthMethod {
  id: string;
  type: 'agent' | 'env_var' | 'terminal';
  label?: string;
  envVars?: string[];
}

// ── Standard JSON-RPC error codes ────────────────────────────────

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

// ── Agent implementation ─────────────────────────────────────────

export class AlmytyAcpAgent {
  private readonly proxy: AlmytyProxy;
  private readonly sessions: SessionManager;
  private readonly agentId: string;
  private send: SendFn;
  private agentInfo: AgentInfo | null = null;
  private authenticated = false;

  constructor(proxy: AlmytyProxy, agentId: string, send: SendFn) {
    this.proxy = proxy;
    this.sessions = new SessionManager();
    this.agentId = agentId;
    this.send = send;
  }

  /**
   * Update the send function (used if transport is re-initialized).
   */
  setSend(send: SendFn): void {
    this.send = send;
  }

  /**
   * Handle an incoming JSON-RPC message from the ACP client.
   */
  async handleMessage(msg: JsonRpcRequest): Promise<void> {
    const { id, method, params } = msg;

    // Notifications have no id — they don't expect a response
    const isNotification = id === undefined || id === null;

    try {
      let result: unknown;

      switch (method) {
        case 'initialize':
          result = await this.handleInitialize(params ?? {});
          break;

        case 'authenticate':
          result = await this.handleAuthenticate(params ?? {});
          break;

        case 'session/new':
          result = await this.handleSessionNew(params ?? {});
          break;

        case 'session/list':
          result = await this.handleSessionList();
          break;

        case 'session/load':
          result = await this.handleSessionLoad(params ?? {});
          break;

        case 'session/prompt':
          result = await this.handleSessionPrompt(params ?? {});
          break;

        case 'session/cancel':
          this.handleSessionCancel(params ?? {});
          if (isNotification) return; // No response for notifications
          result = {};
          break;

        case 'session/set_mode':
          result = this.handleSessionSetMode(params ?? {});
          break;

        case 'session/set_config_option':
          result = {};
          break;

        case 'session/close':
          result = this.handleSessionClose(params ?? {});
          break;

        case 'logout':
          this.authenticated = false;
          result = {};
          break;

        // Document sync notifications — acknowledge silently
        case 'document/didOpen':
        case 'document/didChange':
        case 'document/didClose':
        case 'document/didSave':
        case 'document/didFocus':
          return; // Notifications, no response

        default:
          if (isNotification) return;
          this.sendError(id!, METHOD_NOT_FOUND, `Unknown method: ${method}`);
          return;
      }

      if (!isNotification) {
        this.sendResult(id!, result);
      }
    } catch (err) {
      if (!isNotification) {
        if (err instanceof JsonRpcError) {
          this.sendError(id!, err.code, err.message, err.data);
        } else {
          const message = err instanceof Error ? err.message : String(err);
          this.sendError(id!, INTERNAL_ERROR, message);
        }
      } else {
        process.stderr.write(`[acp] Error handling notification ${method}: ${err}\n`);
      }
    }
  }

  // ── Method handlers ────────────────────────────────────────────

  private async handleInitialize(_params: Record<string, unknown>): Promise<InitializeResult> {
    // Pre-fetch agent info for capabilities
    try {
      this.agentInfo = await this.proxy.getAgent(this.agentId);
    } catch (err) {
      process.stderr.write(`[acp] Warning: could not fetch agent info: ${err}\n`);
    }

    const hasPipeline = this.agentInfo?.mode === 'workflow' && this.agentInfo.pipeline?.nodes?.length;

    return {
      protocolVersion: 1,
      agentCapabilities: {
        tools: true,
        streaming: true,
        sessions: true,
        sessionList: true,
        plan: !!hasPipeline,
        modes: false,
      },
      authMethods: [
        {
          id: 'almyty_token',
          type: 'env_var',
          label: 'almyty API token',
          envVars: ['ALMYTY_TOKEN'],
        },
      ],
      agentInfo: this.agentInfo
        ? { name: this.agentInfo.name, description: this.agentInfo.description }
        : { name: 'almyty agent' },
    };
  }

  private async handleAuthenticate(params: Record<string, unknown>): Promise<{ authenticated: boolean }> {
    const methodId = params.methodId as string | undefined;

    if (methodId === 'almyty_token') {
      // The token is already configured via env var or credentials file.
      // Validate by making a lightweight API call.
      try {
        await this.proxy.getAgent(this.agentId);
        this.authenticated = true;
        return { authenticated: true };
      } catch {
        return { authenticated: false };
      }
    }

    // Unknown auth method — the token was pre-configured at startup,
    // so we consider it authenticated if we can reach the backend.
    try {
      await this.proxy.getAgent(this.agentId);
      this.authenticated = true;
      return { authenticated: true };
    } catch {
      return { authenticated: false };
    }
  }

  private async handleSessionNew(params: Record<string, unknown>): Promise<{ sessionId: string }> {
    const mode = this.agentInfo?.mode ?? 'workflow';
    const session = this.sessions.create(this.agentId, mode);

    process.stderr.write(`[acp] Session created: ${session.id} (agent: ${this.agentId}, mode: ${mode})\n`);

    // For workflow agents with a pipeline, send the plan
    if (mode === 'workflow' && this.agentInfo?.pipeline?.nodes?.length) {
      const plan = buildPlanFromPipeline(this.agentInfo.pipeline.nodes);
      this.sendNotification('session/update', {
        sessionId: session.id,
        update: plan,
      });
    }

    return { sessionId: session.id };
  }

  private async handleSessionList(): Promise<{ sessions: Array<{ id: string; agentId: string; mode: string }> }> {
    const sessions = this.sessions.list().map((s) => ({
      id: s.id,
      agentId: s.agentId,
      mode: s.mode,
    }));
    return { sessions };
  }

  private async handleSessionLoad(params: Record<string, unknown>): Promise<{ sessionId: string }> {
    const sessionId = params.sessionId as string;
    if (!sessionId) {
      throw new JsonRpcError(INVALID_PARAMS, 'sessionId is required');
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new JsonRpcError(INVALID_PARAMS, `Session not found: ${sessionId}`);
    }

    return { sessionId: session.id };
  }

  private async handleSessionPrompt(params: Record<string, unknown>): Promise<PromptResponse> {
    const sessionId = params.sessionId as string;
    if (!sessionId) {
      throw new JsonRpcError(INVALID_PARAMS, 'sessionId is required');
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new JsonRpcError(INVALID_PARAMS, `Session not found: ${sessionId}`);
    }

    // Extract text from ContentBlock array
    // ACP spec uses "prompt", some clients send "content"
    const content = (params.prompt || params.content) as ContentBlock[] | undefined;
    const inputText = extractTextFromContent(content);

    if (!inputText) {
      throw new JsonRpcError(INVALID_PARAMS, 'No text content in prompt');
    }

    // Set up abort controller for this prompt turn
    const abortController = new AbortController();
    this.sessions.update(sessionId, { abortController });

    try {
      if (session.mode === 'autonomous') {
        return await this.handleAutonomousPrompt(session, inputText, abortController.signal);
      } else {
        return await this.handleWorkflowPrompt(session, inputText, abortController.signal);
      }
    } finally {
      this.sessions.update(sessionId, { abortController: undefined, activeRunId: undefined });
    }
  }

  /**
   * Handle a prompt for a workflow agent: POST /agents/:id/stream.
   * Streams events via SSE and maps them to ACP session updates.
   */
  private async handleWorkflowPrompt(
    session: Session,
    input: string,
    signal: AbortSignal,
  ): Promise<PromptResponse> {
    const collectedText: string[] = [];

    try {
      for await (const event of this.proxy.streamAgent(session.agentId, { input }, signal)) {
        if (signal.aborted) {
          return { stopReason: 'cancelled' };
        }

        const updates = mapStreamEvent(event);
        for (const update of updates) {
          this.sendSessionUpdate(session.id, update);

          if (update.type === 'agent_message_chunk') {
            collectedText.push(update.text);
          }
        }

        if (isTerminalEvent(event)) {
          const finalOutput = extractFinalOutput(event);
          if (finalOutput && !collectedText.includes(finalOutput)) {
            collectedText.push(finalOutput);
          }
          if (event.event === 'execution.error' || event.event === 'run.error') {
            return {
              stopReason: 'end_turn',
            };
          }
        }
      }
    } catch (err) {
      if (signal.aborted) {
        return { stopReason: 'cancelled' };
      }

      // If streaming fails, fall back to synchronous invoke
      process.stderr.write(`[acp] Streaming failed, falling back to invoke: ${err}\n`);
      try {
        const result = await this.proxy.invokeAgent(session.agentId, { input });
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);

        this.sendSessionUpdate(session.id, {
          type: 'agent_message_chunk',
          text,
        });

        return {
          stopReason: 'end_turn',
        };
      } catch (invokeErr) {
        const errMsg = invokeErr instanceof Error ? invokeErr.message : String(invokeErr);
        return {
          stopReason: 'end_turn',
        };
      }
    }

    return {
      stopReason: 'end_turn',
      content: collectedText.length > 0
        ? [{ type: 'text', text: collectedText.join('') }]
        : undefined,
    };
  }

  /**
   * Handle a prompt for an autonomous agent: start or continue a run.
   * If the session has no active conversation, starts a new run.
   * If the agent is waiting for input, sends input to the existing run.
   */
  private async handleAutonomousPrompt(
    session: Session,
    input: string,
    signal: AbortSignal,
  ): Promise<PromptResponse> {
    const collectedText: string[] = [];

    try {
      let run: AgentRun;

      if (session.activeRunId) {
        // Continue an existing run that is waiting for input
        run = await this.proxy.sendRunInput(session.agentId, session.activeRunId, { message: input });
      } else {
        // Start a new run, reusing the session's conversation for history
        run = await this.proxy.startRun(session.agentId, { message: input }, session.conversationId);
        this.sessions.update(session.id, {
          activeRunId: run.id,
          conversationId: run.conversationId || session.conversationId,
        });
      }

      process.stderr.write(`[acp] Run started: ${run.id} (status: ${run.status})\n`);

      // Stream events from the run
      try {
        for await (const event of this.proxy.streamRun(session.agentId, run.id, signal)) {
          if (signal.aborted) {
            // Try to cancel the run on the backend
            try { await this.proxy.cancelRun(session.agentId, run.id); } catch { /* best effort */ }
            return { stopReason: 'cancelled' };
          }

          const updates = mapStreamEvent(event);
          for (const update of updates) {
            this.sendSessionUpdate(session.id, update);

            if (update.type === 'agent_message_chunk') {
              collectedText.push(update.text);
            }
          }

          if (isTerminalEvent(event)) {
            const finalOutput = extractFinalOutput(event);
            if (finalOutput && !collectedText.includes(finalOutput)) {
              collectedText.push(finalOutput);
            }
            break;
          }
        }
      } catch (streamErr) {
        // If streaming fails, fall back to polling the run status
        process.stderr.write(`[acp] Run streaming failed, polling: ${streamErr}\n`);
        const finalRun = await this.pollRunToCompletion(session.agentId, run.id, signal);

        if (finalRun.output) {
          const text = typeof finalRun.output === 'string'
            ? finalRun.output
            : JSON.stringify(finalRun.output, null, 2);
          collectedText.push(text);

          this.sendSessionUpdate(session.id, {
            type: 'agent_message_chunk',
            text,
          });
        }

        if (finalRun.error) {
          collectedText.push(`Error: ${finalRun.error}`);
        }

        if (finalRun.status === 'waiting_input') {
          // Agent needs more input — keep the run active
          this.sessions.update(session.id, { activeRunId: finalRun.id });
          return {
            stopReason: 'end_turn',
            content: collectedText.length > 0
              ? [{ type: 'text', text: collectedText.join('') }]
              : [{ type: 'text', text: 'The agent is waiting for your input.' }],
          };
        }
      }

      // Check final run status — if still running, poll until complete
      let finalRun = await this.proxy.getRun(session.agentId, run.id).catch(() => run);

      if (finalRun.status === 'running') {
        process.stderr.write(`[acp] Run still running after stream ended, polling...\n`);
        finalRun = await this.pollRunToCompletion(session.agentId, run.id, signal);
      }

      // Send output if streaming didn't capture it
      if (collectedText.length === 0 && finalRun.output) {
        const text = typeof finalRun.output === 'string'
          ? finalRun.output
          : JSON.stringify(finalRun.output, null, 2);
        collectedText.push(text);
        this.sendSessionUpdate(session.id, { type: 'agent_message_chunk', text });
      }
      if (finalRun.error) {
        const errText = typeof finalRun.error === 'string'
          ? finalRun.error
          : JSON.stringify(finalRun.error);
        if (!collectedText.includes(`Error: ${errText}`)) {
          collectedText.push(`Error: ${errText}`);
        }
      }

      if (finalRun.status === 'waiting_input') {
        this.sessions.update(session.id, { activeRunId: finalRun.id });
      } else {
        this.sessions.update(session.id, { activeRunId: undefined });
      }

      if (finalRun.status === 'cancelled') {
        return { stopReason: 'cancelled' };
      }

      return {
        stopReason: finalRun.status === 'failed' ? 'refusal' : 'end_turn',
        content: collectedText.length > 0
          ? [{ type: 'text', text: collectedText.join('') }]
          : undefined,
      };
    } catch (err) {
      if (signal.aborted) {
        return { stopReason: 'cancelled' };
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        stopReason: 'end_turn',
      };
    }
  }

  /**
   * Poll a run until it reaches a terminal state or the signal is aborted.
   */
  private async pollRunToCompletion(
    agentId: string,
    runId: string,
    signal: AbortSignal,
  ): Promise<AgentRun> {
    const POLL_INTERVAL_MS = 1000;
    const MAX_POLLS = 300; // 5 minutes max

    for (let i = 0; i < MAX_POLLS; i++) {
      if (signal.aborted) {
        throw new Error('Cancelled');
      }

      const run = await this.proxy.getRun(agentId, runId);

      if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled' || run.status === 'waiting_input') {
        return run;
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    throw new Error('Run polling timed out');
  }

  private handleSessionCancel(params: Record<string, unknown>): void {
    const sessionId = params.sessionId as string;
    if (sessionId) {
      process.stderr.write(`[acp] Cancelling session: ${sessionId}\n`);
      this.sessions.cancel(sessionId);
    }
  }

  private handleSessionSetMode(params: Record<string, unknown>): Record<string, unknown> {
    const sessionId = params.sessionId as string;
    const mode = params.mode as string | undefined;

    if (sessionId && mode) {
      this.sessions.update(sessionId, { userMode: mode });
    }

    // Acknowledge but no-op — almyty agents don't have client-side modes
    return {};
  }

  private handleSessionClose(params: Record<string, unknown>): { closed: boolean } {
    const sessionId = params.sessionId as string;
    if (!sessionId) {
      throw new JsonRpcError(INVALID_PARAMS, 'sessionId is required');
    }
    const closed = this.sessions.close(sessionId);
    process.stderr.write(`[acp] Session closed: ${sessionId} (found: ${closed})\n`);
    return { closed };
  }

  // ── Message sending helpers ────────────────────────────────────

  private sendResult(id: string | number, result: unknown): void {
    this.send({
      jsonrpc: '2.0',
      id,
      result,
    });
  }

  private sendError(id: string | number, code: number, message: string, data?: unknown): void {
    this.send({
      jsonrpc: '2.0',
      id,
      error: { code, message, data },
    });
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    this.send({
      jsonrpc: '2.0',
      method,
      params,
    });
  }

  private sendSessionUpdate(sessionId: string, update: SessionUpdatePayload): void {
    // Transform internal format to ACP spec format:
    // - "type" -> "sessionUpdate"
    // - text content wrapped in { type: 'text', text }
    const specUpdate: Record<string, unknown> = { ...update };
    if ('type' in specUpdate) {
      specUpdate.sessionUpdate = specUpdate.type;
      delete specUpdate.type;
    }
    // Wrap bare text in content object for message/thought chunks
    if (specUpdate.sessionUpdate === 'agent_message_chunk' || specUpdate.sessionUpdate === 'agent_thought_chunk') {
      if ('text' in specUpdate && !('content' in specUpdate)) {
        specUpdate.content = { type: 'text', text: specUpdate.text };
        delete specUpdate.text;
      }
    }
    this.sendNotification('session/update', {
      sessionId,
      update: specUpdate,
    });
  }

  /**
   * Clean up all sessions. Called during shutdown.
   */
  shutdown(): void {
    this.sessions.closeAll();
  }
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Extract plain text from an array of ACP ContentBlocks.
 */
function extractTextFromContent(content?: ContentBlock[]): string {
  if (!content || !Array.isArray(content)) return '';
  return content
    .filter((block) => block.type === 'text' && block.text)
    .map((block) => block.text!)
    .join('\n');
}

/**
 * Typed JSON-RPC error for structured error responses.
 */
class JsonRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}
