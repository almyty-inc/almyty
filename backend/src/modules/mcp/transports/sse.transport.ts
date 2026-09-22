import { Injectable, Logger } from '@nestjs/common';
import { Response } from 'express';
import { EventEmitter } from 'events';

import { McpService } from '../mcp.service';
import { McpSessionService } from '../mcp-session.service';
import { JsonRpcRequest, JsonRpcResponse, McpSession } from '../types/mcp.types';
import { randomUUID } from 'crypto';

export interface SseConnection {
  id: string;
  sessionId: string;
  response: Response;
  organizationId: string;
  userId?: string;
  isAlive: boolean;
  /**
   * Time of the last CLIENT-initiated activity (a JSON-RPC POST against
   * `handleSseMessage`). Used by the ping loop to decide whether to send
   * a keep-alive ping and whether the connection has gone stale.
   *
   * Server-side `sendEvent` calls (pings, notifications, message replies)
   * deliberately do NOT update this field — otherwise the server's own
   * pings would refresh the timer and the stale check could never fire.
   */
  lastClientActivity: Date;
}

@Injectable()
export class SseTransport extends EventEmitter {
  private readonly logger = new Logger(SseTransport.name);
  private readonly connections = new Map<string, SseConnection>();
  private pingInterval?: NodeJS.Timeout;

  constructor(
    private readonly mcpService: McpService,
    private readonly mcpSessionService: McpSessionService,
  ) {
    super();
    this.startPingLoop();
    this.setupNotificationHandler();
  }

  // SSE Connection Management
  async handleSseConnection(
    response: Response,
    organizationId: string,
    userId?: string,
    serverId?: string,
  ): Promise<string> {
    // randomUUID, not Date.now()+Math.random(): the id is what a POST to
    // this connection is addressed by, and Math.random() is not a CSPRNG
    // -- an attacker who opens their own connection samples the same
    // generator and can predict neighbouring ids.
    const connectionId = `sse_${randomUUID()}`;
    
    // Create MCP session
    const session = this.mcpSessionService.createSession(organizationId, 'sse', userId);
    
    // Setup SSE headers
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'Cache-Control');

    const connection: SseConnection = {
      id: connectionId,
      sessionId: session.id,
      response,
      organizationId,
      userId,
      isAlive: true,
      lastClientActivity: new Date(),
    };

    this.connections.set(connectionId, connection);

    // MCP 2024-11-05 "HTTP with SSE" transport: the FIRST event on the
    // stream MUST be `endpoint`, and its `data` is the bare URI the
    // client POSTs its JSON-RPC messages to -- a raw URI, not JSON.
    // Both official SDKs resolve it relative to the SSE URL and reject
    // a cross-origin result, so a same-origin relative path is emitted.
    //
    // This used to send a single `event: connected` frame carrying
    // `session.id`. Nothing could drive the transport: the SDKs only
    // resolve their handshake from an `endpoint` listener, and the id in
    // that frame was the MCP session id while POSTs are addressed by
    // `connectionId` -- so even a hand-rolled client reading `connected`
    // got -32001 Connection not found.
    this.sendEvent(connectionId, 'endpoint', this.buildMessageEndpoint(response, connectionId));

    // Informational frame kept after the spec handshake for almyty's own
    // clients. Unknown event names are ignored by the TypeScript SDK and
    // merely logged by the Python one, so it is safe to trail the
    // mandatory `endpoint` event. It now carries BOTH identifiers so it
    // can no longer hand out the wrong one.
    this.sendEvent(connectionId, 'connected', {
      connectionId,
      sessionId: session.id,
      messageEndpoint: this.buildMessageEndpoint(response, connectionId),
      protocolVersion: '2024-11-05',
      serverInfo: {
        name: 'almyty',
        version: '1.0.0',
        transport: 'sse',
      },
    });

    this.logger.log(`SSE connection established: ${connectionId} for session: ${session.id}`);

    // Handle client disconnect
    response.on('close', () => {
      this.closeConnection(connectionId);
    });

    response.on('error', (error) => {
      this.logger.error(`SSE connection error: ${error.message}`);
      this.closeConnection(connectionId);
    });

    return connectionId;
  }

  // Send JSON-RPC messages via SSE
  async sendMessage(connectionId: string, message: JsonRpcResponse): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection || !connection.isAlive) {
      return;
    }

    try {
      this.sendEvent(connectionId, 'message', message);
    } catch (error) {
      this.logger.error(`Failed to send SSE message: ${error.message}`);
      this.closeConnection(connectionId);
    }
  }

  // Broadcast to all connections in organization
  async broadcast(organizationId: string, message: any): Promise<number> {
    let sentCount = 0;
    
    for (const connection of this.connections.values()) {
      if (connection.organizationId === organizationId && connection.isAlive) {
        await this.sendMessage(connection.id, message);
        sentCount++;
      }
    }

    return sentCount;
  }

  // Handle incoming JSON-RPC requests via POST to SSE endpoint
  /**
   * `callerOrganizationId` is required: the connection is not proof of
   * who is posting to it.
   *
   * This ran the JSON-RPC under `connection.organizationId` and
   * `connection.userId` and returned the result in the poster's own HTTP
   * response, so posting to somebody else's connection id enumerated and
   * EXECUTED tools in their organization. Connection ids were
   * `Date.now()` plus `Math.random()`, which is not a CSPRNG and can be
   * sampled by opening your own connection.
   *
   * A foreign id answers exactly as an unknown one, so this does not
   * confirm which ids exist.
   */
  async handleSseMessage(
    connectionId: string,
    message: JsonRpcRequest,
    callerOrganizationId?: string,
  ): Promise<JsonRpcResponse> {
    const connection = this.connections.get(connectionId);
    if (connection && callerOrganizationId && connection.organizationId !== callerOrganizationId) {
      return {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32001, message: 'Connection not found' },
      };
    }
    if (!connection) {
      return {
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32001,
          message: 'Connection not found',
        },
      };
    }

    // Client just sent a JSON-RPC message — refresh liveness timer.
    connection.lastClientActivity = new Date();

    // Process the JSON-RPC request
    try {
      const response = await this.mcpService.handleJsonRpc(
        message,
        connection.organizationId,
        connection.userId,
      );

      // Send response via SSE
      await this.sendMessage(connectionId, response);
      
      return response;
    } catch (error) {
      const errorResponse: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32603,
          message: 'Internal error',
          data: error.message,
        },
      };

      await this.sendMessage(connectionId, errorResponse);
      return errorResponse;
    }
  }

  /**
   * The URI a client must POST its JSON-RPC messages to, as carried by
   * the spec's `endpoint` event.
   *
   * Deliberately a PATH-RELATIVE URI, resolved by the client against the
   * SSE URL it actually opened. An absolute path cannot work here: the
   * ingress rewrites `/api(/|$)(.*)` to `/$2` and the vite dev proxy does
   * the same, so a client that opened `https://tenant/api/mcp/sse` reaches
   * an Express that only ever sees `/mcp/sse`. Anything absolute this
   * server builds would drop the `/api` the client needs, and point at a
   * path the ingress does not route. Relative resolution restores whatever
   * prefix the client used, and lands on the same origin — which both
   * official SDKs require.
   *
   * There is one POST route, `…/mcp/sse/:connectionId/message`, while the
   * stream can be opened at `…/mcp/sse` or `…/mcp/servers/:serverId/sse`,
   * so the climb back up to the `mcp/` directory is computed rather than
   * assumed.
   */
  private buildMessageEndpoint(response: Response, connectionId: string): string {
    const target = `sse/${encodeURIComponent(connectionId)}/message`;
    const raw = (response.req?.originalUrl ?? response.req?.url ?? '') as string;
    const path = raw.split('?')[0];
    const marker = path.indexOf('/mcp/');
    if (marker < 0) {
      // Not a path this transport recognises; an absolute URI is the best
      // guess left, and is correct wherever no prefix is being stripped.
      return `/mcp/${target}`;
    }
    // Segments below the `mcp/` directory, excluding the final one (which
    // relative resolution replaces anyway).
    const depth = path.slice(marker + '/mcp/'.length).split('/').length - 1;
    return `${'../'.repeat(depth)}${target}`;
  }

  // Utility methods
  private sendEvent(connectionId: string, event: string, data: any): void {
    const connection = this.connections.get(connectionId);
    if (!connection || !connection.isAlive) {
      return;
    }

    try {
      // A string payload is written verbatim: the `endpoint` event's data
      // is a bare URI, not a JSON document. Everything else is JSON.
      const payload = typeof data === 'string' ? data : JSON.stringify(data);
      const eventData = `event: ${event}\ndata: ${payload}\n\n`;
      connection.response.write(eventData);
      // Intentionally NOT updating lastClientActivity — see field doc.
    } catch (error) {
      this.logger.error(`Failed to send SSE event: ${error.message}`);
      this.closeConnection(connectionId);
    }
  }

  private closeConnection(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return;
    }

    connection.isAlive = false;
    
    try {
      if (!connection.response.destroyed) {
        connection.response.end();
      }
    } catch (error) {
      // Connection already closed
    }

    // Remove session
    this.mcpSessionService.removeSession(connection.sessionId);
    this.connections.delete(connectionId);

    this.logger.log(`SSE connection closed: ${connectionId}`);
    this.emit('connectionClosed', connectionId);
  }

  // Keep-alive ping mechanism
  private startPingLoop(): void {
    this.pingInterval = setInterval(() => {
      const now = new Date();
      const connectionIds = Array.from(this.connections.keys());

      for (const connectionId of connectionIds) {
        const connection = this.connections.get(connectionId);
        if (!connection) continue;

        // Both checks measure silence from the CLIENT side. Server-initiated
        // pings/notifications no longer touch this timer, so the stale check
        // is now actually reachable.
        const timeSinceClientActivity = now.getTime() - connection.lastClientActivity.getTime();

        // Stale: no client activity for 2 minutes -> tear down.
        if (timeSinceClientActivity > 120000) {
          this.logger.warn(`Closing stale SSE connection: ${connectionId}`);
          this.closeConnection(connectionId);
          continue;
        }

        // Keep-alive: send a ping if the client has been silent for >30s.
        // Pings double as a write-failure liveness probe — if the underlying
        // socket is dead, sendEvent will throw and closeConnection runs.
        if (timeSinceClientActivity > 30000) {
          this.sendEvent(connectionId, 'ping', { timestamp: now.toISOString() });
        }
      }
    }, 30000);
    // .unref() so the ping loop doesn't keep the event loop alive
    // through graceful shutdown or test runs.
    this.pingInterval.unref?.();
  }

  // Setup notification handler
  private setupNotificationHandler(): void {
    this.mcpSessionService.on('notification', (sessionId: string, notification: any) => {
      // Find SSE connection for this session
      for (const connection of this.connections.values()) {
        if (connection.sessionId === sessionId && connection.isAlive) {
          this.sendEvent(connection.id, 'notification', notification);
          break;
        }
      }
    });
  }

  // Connection statistics
  getConnectionStats(): {
    total: number;
    byOrganization: Record<string, number>;
    averageAge: number;
  } {
    const now = new Date();
    const byOrganization: Record<string, number> = {};
    let totalAge = 0;

    for (const connection of this.connections.values()) {
      if (connection.isAlive) {
        byOrganization[connection.organizationId] = (byOrganization[connection.organizationId] || 0) + 1;
        totalAge += now.getTime() - connection.lastClientActivity.getTime();
      }
    }

    return {
      total: this.connections.size,
      byOrganization,
      averageAge: this.connections.size > 0 ? totalAge / this.connections.size / 1000 : 0, // in seconds
    };
  }

  // Cleanup
  async shutdown(): Promise<void> {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }

    // Close all connections
    const connectionIds = Array.from(this.connections.keys());
    for (const connectionId of connectionIds) {
      this.closeConnection(connectionId);
    }

    this.logger.log('SSE transport shutdown complete');
  }
}