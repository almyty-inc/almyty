import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios from 'axios';

import { Gateway } from '../../entities/gateway.entity';
import { GatewayTool } from '../../entities/gateway-tool.entity';
import { Tool } from '../../entities/tool.entity';
import { Organization } from '../../entities/organization.entity';

import { McpTool, McpCapabilities, McpSession } from './types/mcp.types';
import { McpSessionService } from './mcp-session.service';

export interface VirtualServer {
  id: string;
  name: string;
  description?: string;
  organizationId: string;
  toolIds: string[];
  capabilities: McpCapabilities;
  isActive: boolean;
  endpoint?: string;
  metadata?: Record<string, any>;
}

export interface GatewayPeer {
  id: string;
  name: string;
  endpoint: string;
  capabilities: McpCapabilities;
  isActive: boolean;
  lastSeen: Date;
  organizationId: string;
}

@Injectable()
export class McpGatewayService {
  private readonly logger = new Logger(McpGatewayService.name);
  private readonly virtualServers = new Map<string, VirtualServer>();
  private readonly gatewayPeers = new Map<string, GatewayPeer>();

  constructor(
    @InjectRepository(Gateway)
    private gatewayRepository: Repository<Gateway>,
    @InjectRepository(GatewayTool)
    private gatewayToolRepository: Repository<GatewayTool>,
    @InjectRepository(Tool)
    private toolRepository: Repository<Tool>,
    @InjectRepository(Organization)
    private organizationRepository: Repository<Organization>,
    private mcpSessionService: McpSessionService,
  ) {}

  // Virtual Server Management
  async createVirtualServer(
    organizationId: string,
    serverData: {
      name: string;
      description?: string;
      toolIds: string[];
      capabilities?: McpCapabilities;
      metadata?: Record<string, any>;
    }
  ): Promise<VirtualServer> {
    // Verify tools belong to organization
    const tools = await this.toolRepository.find({
      where: {
        id: { $in: serverData.toolIds } as any,
        organizationId,
      },
    });

    if (tools.length !== serverData.toolIds.length) {
      throw new BadRequestException('Some tools not found or not accessible');
    }

    const virtualServer: VirtualServer = {
      id: `vs_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name: serverData.name,
      description: serverData.description,
      organizationId,
      toolIds: serverData.toolIds,
      capabilities: serverData.capabilities || {
        tools: { listChanged: true },
        experimental: {
          almyty: {
            universalApiTranslation: true,
            virtualServer: true,
          },
        },
      },
      isActive: true,
      endpoint: `/api/mcp/servers/${this.generateServerId()}`,
      metadata: serverData.metadata,
    };

    this.virtualServers.set(virtualServer.id, virtualServer);

    this.logger.log(`Virtual server created: ${virtualServer.id} with ${tools.length} tools`);

    // Broadcast tools list changed notification
    await this.mcpSessionService.broadcastToOrganization(organizationId, {
      method: 'notifications/tools/list_changed',
    });

    return virtualServer;
  }

  async getVirtualServer(serverId: string): Promise<VirtualServer | null> {
    return this.virtualServers.get(serverId) || null;
  }

  async listVirtualServers(organizationId: string): Promise<VirtualServer[]> {
    return Array.from(this.virtualServers.values()).filter(
      server => server.organizationId === organizationId && server.isActive
    );
  }

  async updateVirtualServer(
    serverId: string,
    updates: Partial<VirtualServer>
  ): Promise<VirtualServer | null> {
    const server = this.virtualServers.get(serverId);
    if (!server) {
      return null;
    }

    Object.assign(server, updates);
    this.virtualServers.set(serverId, server);

    this.logger.log(`Virtual server updated: ${serverId}`);
    return server;
  }

  async deleteVirtualServer(serverId: string): Promise<boolean> {
    const server = this.virtualServers.get(serverId);
    if (!server) {
      return false;
    }

    this.virtualServers.delete(serverId);
    
    // Broadcast notification
    await this.mcpSessionService.broadcastToOrganization(server.organizationId, {
      method: 'notifications/tools/list_changed',
    });

    this.logger.log(`Virtual server deleted: ${serverId}`);
    return true;
  }

  // Get tools for a specific virtual server
  async getVirtualServerTools(serverId: string): Promise<McpTool[]> {
    const server = this.virtualServers.get(serverId);
    if (!server) {
      throw new NotFoundException('Virtual server not found');
    }

    const tools = await this.toolRepository.find({
      where: {
        id: { $in: server.toolIds } as any,
      },
    });

    return tools.map(tool => ({
      name: tool.name,
      description: tool.description || `Tool from virtual server ${server.name}`,
      inputSchema: tool.parameters || {
        type: 'object',
        properties: {},
      },
    }));
  }

  // Gateway Peer Federation
  async registerGatewayPeer(
    organizationId: string,
    peerData: {
      name: string;
      endpoint: string;
      capabilities?: McpCapabilities;
    }
  ): Promise<GatewayPeer> {
    // Test connection to peer
    try {
      const response = await axios.get(`${peerData.endpoint}/.well-known/mcp`, {
        timeout: 5000,
      });
      
      if (!response.data.protocol || response.data.protocol !== 'mcp') {
        throw new BadRequestException('Endpoint is not a valid MCP gateway');
      }
    } catch (error) {
      throw new BadRequestException(`Cannot connect to peer gateway: ${error.message}`);
    }

    const peer: GatewayPeer = {
      id: `peer_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name: peerData.name,
      endpoint: peerData.endpoint,
      capabilities: peerData.capabilities || { tools: {}, resources: {}, prompts: {} },
      isActive: true,
      lastSeen: new Date(),
      organizationId,
    };

    this.gatewayPeers.set(peer.id, peer);

    this.logger.log(`Gateway peer registered: ${peer.id} at ${peer.endpoint}`);
    return peer;
  }

  async listGatewayPeers(organizationId: string): Promise<GatewayPeer[]> {
    return Array.from(this.gatewayPeers.values()).filter(
      peer => peer.organizationId === organizationId && peer.isActive
    );
  }

  async removeGatewayPeer(peerId: string): Promise<boolean> {
    const peer = this.gatewayPeers.get(peerId);
    if (!peer) {
      return false;
    }

    this.gatewayPeers.delete(peerId);
    this.logger.log(`Gateway peer removed: ${peerId}`);
    return true;
  }

  // Federation - Forward requests to peers
  async forwardToPeer(
    peerId: string,
    method: string,
    params: any
  ): Promise<any> {
    const peer = this.gatewayPeers.get(peerId);
    if (!peer) {
      throw new NotFoundException('Gateway peer not found');
    }

    try {
      const response = await axios.post(`${peer.endpoint}/mcp`, {
        jsonrpc: '2.0',
        id: `fwd_${Date.now()}`,
        method,
        params,
      }, {
        timeout: 30000,
        headers: {
          'Content-Type': 'application/json',
        },
      });

      // Update last seen
      peer.lastSeen = new Date();
      this.gatewayPeers.set(peerId, peer);

      return response.data;
    } catch (error) {
      this.logger.error(`Failed to forward request to peer ${peerId}: ${error.message}`);
      
      // Mark peer as inactive if unreachable
      if (error.code === 'ECONNREFUSED' || error.response?.status >= 500) {
        peer.isActive = false;
        this.gatewayPeers.set(peerId, peer);
      }
      
      throw new BadRequestException(`Peer gateway request failed: ${error.message}`);
    }
  }

  // Server Composition - Combine multiple servers/peers
  async getComposedTools(organizationId: string): Promise<McpTool[]> {
    const allTools: McpTool[] = [];

    // Add tools from virtual servers
    const virtualServers = await this.listVirtualServers(organizationId);
    for (const server of virtualServers) {
      const serverTools = await this.getVirtualServerTools(server.id);
      allTools.push(...serverTools);
    }

    // Add tools from gateway peers (federated)
    const peers = await this.listGatewayPeers(organizationId);
    for (const peer of peers) {
      try {
        const response = await this.forwardToPeer(peer.id, 'tools/list', {});
        if (response.result?.tools) {
          // Prefix peer tools to avoid conflicts
          const peerTools = response.result.tools.map(tool => ({
            ...tool,
            name: `${peer.name}:${tool.name}`,
            description: `${tool.description || ''} (from ${peer.name})`,
          }));
          allTools.push(...peerTools);
        }
      } catch (error) {
        this.logger.warn(`Failed to get tools from peer ${peer.name}: ${error.message}`);
      }
    }

    return allTools;
  }

  // Health monitoring for peers
  async checkPeerHealth(): Promise<{
    total: number;
    healthy: number;
    unhealthy: number;
    peers: Array<{
      id: string;
      name: string;
      endpoint: string;
      isHealthy: boolean;
      lastSeen: Date;
      responseTime?: number;
    }>;
  }> {
    const results = [];
    let healthyCount = 0;

    for (const peer of this.gatewayPeers.values()) {
      const startTime = Date.now();
      let isHealthy = false;
      let responseTime: number | undefined;

      try {
        await axios.get(`${peer.endpoint}/health`, { timeout: 5000 });
        isHealthy = true;
        responseTime = Date.now() - startTime;
        healthyCount++;
        
        // Update peer status
        peer.isActive = true;
        peer.lastSeen = new Date();
      } catch (error) {
        isHealthy = false;
        peer.isActive = false;
      }

      results.push({
        id: peer.id,
        name: peer.name,
        endpoint: peer.endpoint,
        isHealthy,
        lastSeen: peer.lastSeen,
        responseTime,
      });
    }

    return {
      total: this.gatewayPeers.size,
      healthy: healthyCount,
      unhealthy: this.gatewayPeers.size - healthyCount,
      peers: results,
    };
  }

  private generateServerId(): string {
    return `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}