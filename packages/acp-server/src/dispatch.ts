/**
 * stdio line dispatch for the ACP server.
 *
 * Owns the one piece of state the readline loop cannot own safely: the
 * lazily-resolved agent. `readline` delivers every complete line already
 * sitting in the stdin pipe in a single synchronous burst, so an async
 * `if (!agent) agent = await resolveAgent()` guard inside the line handler
 * is checked by every line in that burst before any of them assigns — each
 * line then builds its own agent, with its own SessionManager and its own
 * (empty) cached agent info. Sessions created by one message are invisible
 * to the next, `initialize` caches the agent mode on an instance nobody
 * keeps, and the backend is asked for the agent list once per line.
 *
 * Resolution is therefore memoised on the in-flight promise, not on the
 * settled value. A failed resolution clears the memo so a later message
 * can retry (the backend may simply have been down).
 */

import type { JsonRpcRequest, JsonRpcResponse, JsonRpcNotification } from './agent.js';

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const INTERNAL_ERROR = -32603;

/** The surface of AlmytyAcpAgent the dispatcher depends on. */
export interface MessageHandler {
  handleMessage(msg: JsonRpcRequest): Promise<void>;
}

export interface LineHandlerOptions {
  /** Build the agent. Called at most once per successful resolution. */
  resolveAgent: () => Promise<MessageHandler>;
  /** Write a JSON-RPC message back to the client. */
  send: (msg: JsonRpcResponse | JsonRpcNotification) => void;
  /** Diagnostic sink. Defaults to stderr — stdout is the protocol. */
  log?: (text: string) => void;
}

/**
 * Build the `line` handler for the ndjson stdio loop.
 */
export function createLineHandler({
  resolveAgent,
  send,
  log = (text: string) => void process.stderr.write(text),
}: LineHandlerOptions): (line: string) => Promise<void> {
  let pending: Promise<MessageHandler> | null = null;

  const agentOnce = (): Promise<MessageHandler> => {
    if (!pending) {
      pending = resolveAgent().catch((err: unknown) => {
        pending = null;
        throw err;
      });
    }
    return pending;
  };

  return async function handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error' } });
      return;
    }

    if (!msg || msg.jsonrpc !== '2.0' || !msg.method) {
      if (msg && msg.id !== undefined) {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: INVALID_REQUEST, message: 'Invalid request' } });
      }
      return;
    }

    let agent: MessageHandler;
    try {
      agent = await agentOnce();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      send({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: INTERNAL_ERROR, message } });
      return;
    }

    try {
      await agent.handleMessage(msg);
    } catch (err: unknown) {
      log(`[acp] Error: ${err}\n`);
      if (msg.id !== undefined && msg.id !== null) {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: INTERNAL_ERROR, message: 'Internal error' } });
      }
    }
  };
}
