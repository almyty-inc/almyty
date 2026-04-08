import { Injectable, Logger } from '@nestjs/common';
import { WebSocket } from 'ws';
import { EventEmitter } from 'events';

import { McpService } from '../mcp.service';
import { McpSessionService } from '../mcp-session.service';
import { JsonRpcRequest, JsonRpcResponse, McpSession } from '../types/mcp.types';

export interface WebSocketConnection {
  id: string;
  sessionId: string;
  ws: WebSocket;
  organizationId: string;
  userId?: string;
  isAlive: boolean;
  lastPong: Date;
  serverId?: string;
}

@Injectable()
export class WebSocketTransport extends EventEmitter {
  private readonly logger = new Logger(WebSocketTransport.name);
  private readonly connections = new Map<string, WebSocketConnection>();
  private heartbeatInterval?: NodeJS.Timeout;

  constructor(
    private readonly mcpService: McpService,
    private readonly mcpSessionService: McpSessionService,
  ) {
    super();
    this.startHeartbeat();
    this.setupNotificationHandler();
  }

  // WebSocket Connection Management
  async handleWebSocketConnection(
    ws: WebSocket,
    organizationId: string,
    userId?: string,
    serverId?: string,
  ): Promise<string> {
    const connectionId = `ws_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Create MCP session
    const session = this.mcpSessionService.createSession(organizationId, 'websocket', userId);

    const connection: WebSocketConnection = {
      id: connectionId,
      sessionId: session.id,
      ws,
      organizationId,
      userId,
      isAlive: true,
      lastPong: new Date(),
      serverId,
    };

    this.connections.set(connectionId, connection);

    // Setup WebSocket event handlers
    ws.on('message', async (data) => {
      await this.handleMessage(connectionId, data.toString());
    });

    ws.on('pong', () => {
      connection.lastPong = new Date();
      connection.isAlive = true;
    });

    ws.on('close', (code, reason) => {
      this.logger.log(`WebSocket closed: ${connectionId} (code: ${code}, reason: ${reason})`);
      this.closeConnection(connectionId);
    });

    ws.on('error', (error) => {
      this.logger.error(`WebSocket error: ${connectionId} - ${error.message}`);
      this.closeConnection(connectionId);
    });

    // Send initial connection message
    this.sendMessage(connectionId, {
      type: 'connection',
      data: {
        sessionId: session.id,
        protocolVersion: '2024-11-05',
        serverInfo: {
          name: 'almyty',
          version: '1.0.0',
          transport: 'websocket',
        },
        capabilities: {
          bidirectional: true,
          streaming: true,
          experimental: {
            almyty: {
              universalApiTranslation: true,
              realTimeToolExecution: true,
            },
          },
        },
      },
    });

    this.logger.log(`WebSocket connection established: ${connectionId} for session: ${session.id}`);

    return connectionId;
  }

  // Handle incoming WebSocket messages
  private async handleMessage(connectionId: string, data: string): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection || !connection.isAlive) {
      return;
    }

    try {
      const message = JSON.parse(data);

      // Handle different message types
      if (message.type === 'ping') {
        // Respond to ping
        this.sendMessage(connectionId, { type: 'pong', timestamp: new Date().toISOString() });
        return;
      }

      if (message.type === 'jsonrpc' || (message.jsonrpc && message.method)) {
        // Handle JSON-RPC request
        const jsonRpcMessage = message.type === 'jsonrpc' ? message.data : message;
        const response = await this.mcpService.handleJsonRpc(
          jsonRpcMessage,
          connection.organizationId,
          connection.userId,
        );

        this.sendMessage(connectionId, {
          type: 'jsonrpc',
          data: response,
        });
        return;
      }

      if (message.type === 'subscribe') {
        // Handle subscription requests
        await this.handleSubscription(connectionId, message.data);
        return;
      }

      // Unknown message type
      this.logger.warn(`Unknown WebSocket message type: ${message.type}`);
      this.sendMessage(connectionId, {
        type: 'error',
        data: {
          code: -32601,
          message: 'Unknown message type',
          data: message.type,
        },
      });

    } catch (error) {
      this.logger.error(`WebSocket message handling error: ${error.message}`);
      this.sendMessage(connectionId, {
        type: 'error',
        data: {
          code: -32700,
          message: 'Parse error',
          data: error.message,
        },
      });
    }
  }

  // Handle subscription requests (resources, tools, prompts)
  private async handleSubscription(connectionId: string, subscriptionData: any): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return;
    }

    const { type, filter } = subscriptionData;

    this.logger.debug(`WebSocket subscription: ${type} for connection ${connectionId}`);

    // Update session capabilities to include subscription support
    this.mcpSessionService.updateSession(connection.sessionId, {
      capabilities: {
        resources: { subscribe: true, listChanged: true },
        tools: { listChanged: true },
        prompts: { listChanged: true },
        experimental: {
          almyty: {
            subscriptions: true,
            realTimeUpdates: true,
          },
        },
      },
    });

    // Send subscription confirmation
    this.sendMessage(connectionId, {
      type: 'subscription',
      data: {
        type,
        status: 'active',
        filter,
      },
    });
  }

  // Send message to WebSocket connection
  private sendMessage(connectionId: string, message: any): void {
    const connection = this.connections.get(connectionId);
    if (!connection || !connection.isAlive) {
      return;
    }

    try {
      if (connection.ws.readyState === WebSocket.OPEN) {
        connection.ws.send(JSON.stringify(message));
      } else {
        this.closeConnection(connectionId);
      }
    } catch (error) {
      this.logger.error(`Failed to send WebSocket message: ${error.message}`);
      this.closeConnection(connectionId);
    }
  }

  // Broadcast to organization
  async broadcastToOrganization(organizationId: string, message: any): Promise<number> {
    let sentCount = 0;

    for (const connection of this.connections.values()) {
      if (connection.organizationId === organizationId && connection.isAlive) {
        this.sendMessage(connection.id, message);
        sentCount++;
      }
    }

    return sentCount;
  }

  // Close WebSocket connection
  private closeConnection(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return;
    }

    connection.isAlive = false;

    try {
      if (connection.ws.readyState === WebSocket.OPEN) {
        connection.ws.close(1000, 'Session ended');
      }
    } catch (error) {
      // Connection already closed
    }

    // Remove session
    this.mcpSessionService.removeSession(connection.sessionId);
    this.connections.delete(connectionId);

    this.logger.log(`WebSocket connection closed: ${connectionId}`);
    this.emit('connectionClosed', connectionId);
  }

  // Heartbeat mechanism
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      const now = new Date();
      const connectionIds = Array.from(this.connections.keys());

      for (const connectionId of connectionIds) {
        const connection = this.connections.get(connectionId);
        if (!connection) continue;

        // Check if connection is stale
        const timeSinceLastPong = now.getTime() - connection.lastPong.getTime();
        if (timeSinceLastPong > 65000) { // 65 seconds (ping interval + buffer)
          this.logger.warn(`Closing stale WebSocket connection: ${connectionId}`);
          this.closeConnection(connectionId);
          continue;
        }

        // Send ping
        if (connection.isAlive && connection.ws.readyState === WebSocket.OPEN) {
          connection.isAlive = false; // Will be set to true when pong is received
          connection.ws.ping();
        }
      }
    }, 30000); // Ping every 30 seconds
    // .unref() so the heartbeat interval doesn't keep the Node
    // process alive through graceful shutdown.
    this.heartbeatInterval.unref?.();
  }

  // Setup notification broadcasting
  private setupNotificationHandler(): void {
    this.mcpSessionService.on('notification', (sessionId: string, notification: any) => {
      // Find WebSocket connection for this session
      for (const connection of this.connections.values()) {
        if (connection.sessionId === sessionId && connection.isAlive) {
          this.sendMessage(connection.id, {
            type: 'notification',
            data: notification,
          });
          break;
        }
      }
    });
  }

  // Connection statistics
  getConnectionStats(): {
    total: number;
    byOrganization: Record<string, number>;
    byServer: Record<string, number>;
    averageAge: number;
  } {
    const now = new Date();
    const byOrganization: Record<string, number> = {};
    const byServer: Record<string, number> = {};
    let totalAge = 0;

    for (const connection of this.connections.values()) {
      if (connection.isAlive) {
        byOrganization[connection.organizationId] = (byOrganization[connection.organizationId] || 0) + 1;
        
        if (connection.serverId) {
          byServer[connection.serverId] = (byServer[connection.serverId] || 0) + 1;
        }
        
        totalAge += now.getTime() - connection.lastPong.getTime();
      }
    }

    return {
      total: this.connections.size,
      byOrganization,
      byServer,
      averageAge: this.connections.size > 0 ? totalAge / this.connections.size / 1000 : 0,
    };
  }

  // Get connections for organization
  getOrganizationConnections(organizationId: string): WebSocketConnection[] {
    return Array.from(this.connections.values()).filter(
      conn => conn.organizationId === organizationId && conn.isAlive
    );
  }

  // Cleanup
  async shutdown(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    // Close all connections
    const connectionIds = Array.from(this.connections.keys());
    for (const connectionId of connectionIds) {
      this.closeConnection(connectionId);
    }

    this.logger.log('WebSocket transport shutdown complete');
  }
}