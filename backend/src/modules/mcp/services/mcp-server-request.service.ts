import { Injectable, Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';

import {
  JsonRpcRequest,
  JsonRpcResponse,
  McpSamplingCreateMessageRequest,
  McpSamplingCreateMessageResult,
  McpElicitationCreateRequest,
  McpElicitationCreateResult,
  McpRootsListResult,
  McpSession,
} from '../types/mcp.types';

export interface PendingRequest {
  id: string;
  method: string;
  resolve: (result: any) => void;
  reject: (error: any) => void;
  timeout: NodeJS.Timeout;
  sessionId: string;
  createdAt: Date;
}

/**
 * Sends JSON-RPC requests from the server to the client.
 *
 * MCP defines three server→client request types:
 * - sampling/createMessage: ask the client's LLM to generate text
 * - elicitation/create: ask the client for structured user input
 * - roots/list: ask the client for its workspace root URIs
 *
 * The service tracks pending requests by id and resolves them when the
 * client sends back a JSON-RPC response. Transports (SSE, WebSocket)
 * call sendToClient to push the request; handleClientResponse is called
 * when the client's response arrives.
 */
@Injectable()
export class McpServerRequestService {
  private readonly logger = new Logger(McpServerRequestService.name);
  private readonly pending = new Map<string, PendingRequest>();

  // Transport callback — set by each transport on connection
  private transportSend: ((sessionId: string, request: JsonRpcRequest) => Promise<void>) | null = null;

  registerTransport(send: (sessionId: string, request: JsonRpcRequest) => Promise<void>): void {
    this.transportSend = send;
  }

  async createMessage(
    sessionId: string,
    session: McpSession,
    params: McpSamplingCreateMessageRequest,
    timeoutMs = 30000,
  ): Promise<McpSamplingCreateMessageResult> {
    if (!session.clientCapabilities?.sampling) {
      throw new Error('Client does not support sampling');
    }

    return this.sendRequest<McpSamplingCreateMessageResult>(
      sessionId,
      'sampling/createMessage',
      params,
      timeoutMs,
    );
  }

  async elicit(
    sessionId: string,
    session: McpSession,
    params: McpElicitationCreateRequest,
    timeoutMs = 60000,
  ): Promise<McpElicitationCreateResult> {
    if (!session.clientCapabilities?.elicitation) {
      throw new Error('Client does not support elicitation');
    }

    return this.sendRequest<McpElicitationCreateResult>(
      sessionId,
      'elicitation/create',
      params,
      timeoutMs,
    );
  }

  async listRoots(
    sessionId: string,
    session: McpSession,
    timeoutMs = 10000,
  ): Promise<McpRootsListResult> {
    if (!session.clientCapabilities?.roots) {
      throw new Error('Client does not support roots');
    }

    return this.sendRequest<McpRootsListResult>(
      sessionId,
      'roots/list',
      {},
      timeoutMs,
    );
  }

  handleClientResponse(response: JsonRpcResponse): boolean {
    const pending = this.pending.get(String(response.id));
    if (!pending) {
      return false;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(String(response.id));

    if (response.error) {
      pending.reject(new Error(`${pending.method} failed: ${response.error.message}`));
    } else {
      pending.resolve(response.result);
    }

    return true;
  }

  getPendingCount(): number {
    return this.pending.size;
  }

  hasPending(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  cancelAll(sessionId: string): number {
    let cancelled = 0;
    for (const [id, pending] of this.pending) {
      if (pending.sessionId === sessionId) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('Session closed'));
        this.pending.delete(id);
        cancelled++;
      }
    }
    return cancelled;
  }

  private async sendRequest<T>(
    sessionId: string,
    method: string,
    params: any,
    timeoutMs: number,
  ): Promise<T> {
    if (!this.transportSend) {
      throw new Error('No transport registered for server-to-client requests');
    }

    const id = uuidv4();
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        id,
        method,
        resolve,
        reject,
        timeout,
        sessionId,
        createdAt: new Date(),
      });

      this.transportSend(sessionId, request).catch((err) => {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(err);
      });
    });
  }
}
