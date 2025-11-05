import { Injectable, Logger } from '@nestjs/common';
import { Response } from 'express';
import { EventEmitter } from 'events';

import { McpService } from '../mcp.service';
import { McpSessionService } from '../mcp-session.service';
import { JsonRpcRequest, JsonRpcResponse, McpSession } from '../types/mcp.types';

export interface SseConnection {
  id: string;
  sessionId: string;
  response: Response;
  organizationId: string;
  userId?: string;
  isAlive: boolean;
  lastPing: Date;
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
    const connectionId = `sse_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
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
      lastPing: new Date(),
    };

    this.connections.set(connectionId, connection);

    // Send initial connection event
    this.sendEvent(connectionId, 'connected', {
      sessionId: session.id,
      protocolVersion: '2024-11-05',
      serverInfo: {
        name: 'apifai',
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
  async handleSseMessage(
    connectionId: string,
    message: JsonRpcRequest,
  ): Promise<JsonRpcResponse> {
    const connection = this.connections.get(connectionId);
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

    // Update last activity
    connection.lastPing = new Date();

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

  // Utility methods
  private sendEvent(connectionId: string, event: string, data: any): void {
    const connection = this.connections.get(connectionId);
    if (!connection || !connection.isAlive) {
      return;
    }

    try {
      const eventData = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      connection.response.write(eventData);
      connection.lastPing = new Date();
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

        // Check if connection is stale (no activity for 2 minutes)
        const timeSinceLastPing = now.getTime() - connection.lastPing.getTime();
        if (timeSinceLastPing > 120000) {
          this.logger.warn(`Closing stale SSE connection: ${connectionId}`);
          this.closeConnection(connectionId);
          continue;
        }

        // Send ping every 30 seconds
        if (timeSinceLastPing > 30000) {
          this.sendEvent(connectionId, 'ping', { timestamp: now.toISOString() });
        }
      }
    }, 30000);
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
        totalAge += now.getTime() - connection.lastPing.getTime();
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