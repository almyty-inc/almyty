import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import axios from 'axios';
import * as crypto from 'crypto';

import { validateUrl } from '../../common/security/url-validator';
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

/**
 * Upper bounds on the in-memory Maps below. Both are populated purely
 * from HTTP calls (createVirtualServer / registerGatewayPeer) — with
 * no eviction there's a trivial memory growth path for an admin who
 * creates servers or peers in a loop. Cap the Maps and drop the
 * oldest entry on overflow (insertion order is stable in JS Maps).
 */
const MCP_VIRTUAL_SERVERS_MAX = 1_000;
const MCP_GATEWAY_PEERS_MAX = 1_000;

function evictOldestEntry<K, V>(map: Map<K, V>): void {
  const firstKey = map.keys().next().value;
  if (firstKey !== undefined) {
    map.delete(firstKey);
  }
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
    // Verify tools belong to organization. Previously this used Mongo's
    // `{ $in: ... }` operator which TypeORM treats as a literal object
    // comparison — so the query matched zero rows and the validation
    // below ALWAYS threw "Some tools not found", making this method
    // entirely non-functional (as long as toolIds was non-empty).
    const tools = serverData.toolIds.length > 0
      ? await this.toolRepository.find({
          where: {
            id: In(serverData.toolIds),
            organizationId,
          },
        })
      : [];

    if (tools.length !== serverData.toolIds.length) {
      throw new BadRequestException('Some tools not found or not accessible');
    }

    const virtualServer: VirtualServer = {
      // Unguessable id — the old `vs_${Date.now()}_${Math.random()...}`
      // shape is both predictable (timestamp-seeded) and non-cryptographic,
      // and this id is referenced from URL paths (endpoint) so a
      // guessable value becomes a trivial enumeration vector against
      // other tenants' servers. crypto.randomBytes gives 128 bits of
      // entropy and is unique per process.
      id: `vs_${crypto.randomBytes(16).toString('hex')}`,
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

    // Cap + FIFO eviction so a loop of createVirtualServer calls can't
    // grow this Map without bound.
    if (this.virtualServers.size >= MCP_VIRTUAL_SERVERS_MAX) {
      evictOldestEntry(this.virtualServers);
    }
    this.virtualServers.set(virtualServer.id, virtualServer);

    this.logger.log(`Virtual server created: ${virtualServer.id} with ${tools.length} tools`);

    // Broadcast tools list changed notification
    await this.mcpSessionService.broadcastToOrganization(organizationId, {
      method: 'notifications/tools/list_changed',
    });

    return virtualServer;
  }

  async getVirtualServer(
    serverId: string,
    organizationId: string,
  ): Promise<VirtualServer | null> {
    // Org-scoped read. The previous shape returned the server for
    // ANY caller that knew its id. Combine with listVirtualServers
    // which already scoped by org — both are now consistent.
    const server = this.virtualServers.get(serverId);
    if (!server || server.organizationId !== organizationId) return null;
    return server;
  }

  async listVirtualServers(organizationId: string): Promise<VirtualServer[]> {
    return Array.from(this.virtualServers.values()).filter(
      server => server.organizationId === organizationId && server.isActive
    );
  }

  async updateVirtualServer(
    serverId: string,
    organizationId: string,
    updates: Partial<VirtualServer>,
  ): Promise<VirtualServer | null> {
    const server = this.virtualServers.get(serverId);
    if (!server || server.organizationId !== organizationId) {
      // Cross-org update attempt — indistinguishable from not found.
      return null;
    }

    // Never let a caller mutate the server's organizationId through
    // the updates bag — that would allow laundering a server across
    // tenants once a cross-org write slipped through.
    const { organizationId: _forbidden, ...safeUpdates } = updates;
    Object.assign(server, safeUpdates);
    this.virtualServers.set(serverId, server);

    this.logger.log(`Virtual server updated: ${serverId}`);
    return server;
  }

  async deleteVirtualServer(
    serverId: string,
    organizationId: string,
  ): Promise<boolean> {
    const server = this.virtualServers.get(serverId);
    if (!server || server.organizationId !== organizationId) {
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
  async getVirtualServerTools(
    serverId: string,
    organizationId: string,
  ): Promise<McpTool[]> {
    const server = this.virtualServers.get(serverId);
    if (!server || server.organizationId !== organizationId) {
      // Cross-org lookup — say "not found" so the endpoint can't be
      // used as an existence oracle for foreign server ids.
      throw new NotFoundException('Virtual server not found');
    }

    // The tool query is already org-scoped (defence in depth even
    // without the server check above), and uses TypeORM's `In()` —
    // the Mongo `$in` shape this used to have was a no-op.
    const tools = server.toolIds.length > 0
      ? await this.toolRepository.find({
          where: {
            id: In(server.toolIds),
            organizationId: server.organizationId,
          },
        })
      : [];

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
    // SSRF guard: the peer endpoint comes from the caller. Without
    // this, a user could register "http://169.254.169.254/" (AWS IMDS),
    // "http://localhost:6379" (internal Redis), or any internal host
    // and our server would happily fetch it.
    const validation = validateUrl(`${peerData.endpoint}/.well-known/mcp`);
    if (!validation.valid) {
      throw new BadRequestException(`Invalid peer endpoint: ${validation.error}`);
    }

    // Test connection to peer
    try {
      const response = await axios.get(`${peerData.endpoint}/.well-known/mcp`, {
        timeout: 5000,
        maxContentLength: 1 * 1024 * 1024,
        maxBodyLength: 1 * 1024 * 1024,
      });
      
      if (!response.data.protocol || response.data.protocol !== 'mcp') {
        throw new BadRequestException('Endpoint is not a valid MCP gateway');
      }
    } catch (error) {
      throw new BadRequestException(`Cannot connect to peer gateway: ${error.message}`);
    }

    const peer: GatewayPeer = {
      // Unguessable id — same reasoning as virtualServer above.
      id: `peer_${crypto.randomBytes(16).toString('hex')}`,
      name: peerData.name,
      endpoint: peerData.endpoint,
      capabilities: peerData.capabilities || { tools: {}, resources: {}, prompts: {} },
      isActive: true,
      lastSeen: new Date(),
      organizationId,
    };

    if (this.gatewayPeers.size >= MCP_GATEWAY_PEERS_MAX) {
      evictOldestEntry(this.gatewayPeers);
    }
    this.gatewayPeers.set(peer.id, peer);

    this.logger.log(`Gateway peer registered: ${peer.id} at ${peer.endpoint}`);
    return peer;
  }

  async listGatewayPeers(organizationId: string): Promise<GatewayPeer[]> {
    return Array.from(this.gatewayPeers.values()).filter(
      peer => peer.organizationId === organizationId && peer.isActive
    );
  }

  async removeGatewayPeer(
    peerId: string,
    organizationId: string,
  ): Promise<boolean> {
    const peer = this.gatewayPeers.get(peerId);
    if (!peer || peer.organizationId !== organizationId) {
      // Cross-org delete — indistinguishable from "peer doesn't exist".
      return false;
    }

    this.gatewayPeers.delete(peerId);
    this.logger.log(`Gateway peer removed: ${peerId}`);
    return true;
  }

  // Federation - Forward requests to peers
  async forwardToPeer(
    peerId: string,
    organizationId: string,
    method: string,
    params: any
  ): Promise<any> {
    const peer = this.gatewayPeers.get(peerId);
    if (!peer || peer.organizationId !== organizationId) {
      throw new NotFoundException('Gateway peer not found');
    }

    // Revalidate the peer endpoint every forward. The register path
    // already runs validateUrl but a future code path that mutates
    // `peer.endpoint` without re-validating (via in-memory update,
    // restore from storage, etc.) would otherwise bypass the SSRF
    // gate.
    const validation = validateUrl(`${peer.endpoint}/mcp`);
    if (!validation.valid) {
      throw new BadRequestException(`Peer endpoint is no longer safe to contact: ${validation.error}`);
    }

    try {
      const response = await axios.post(`${peer.endpoint}/mcp`, {
        jsonrpc: '2.0',
        id: `fwd_${Date.now()}`,
        method,
        params,
      }, {
        timeout: 30000,
        maxContentLength: 10 * 1024 * 1024,
        maxBodyLength: 10 * 1024 * 1024,
        // Don't follow redirects across the SSRF gate.
        maxRedirects: 0,
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
      const serverTools = await this.getVirtualServerTools(server.id, organizationId);
      allTools.push(...serverTools);
    }

    // Add tools from gateway peers (federated)
    const peers = await this.listGatewayPeers(organizationId);
    for (const peer of peers) {
      try {
        const response = await this.forwardToPeer(peer.id, organizationId, 'tools/list', {});
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
        // Revalidate the endpoint on every probe — register already
        // runs validateUrl but this Map is in-memory and the only
        // defence against a stale / tampered entry is a check at
        // use time. And set maxRedirects: 0 so a peer can't 302 us
        // into 169.254.169.254 and bypass the gate.
        const validation = validateUrl(`${peer.endpoint}/health`);
        if (!validation.valid) {
          throw new Error(`peer endpoint no longer safe: ${validation.error}`);
        }
        await axios.get(`${peer.endpoint}/health`, {
          timeout: 5000,
          maxContentLength: 1 * 1024 * 1024,
          maxBodyLength: 1 * 1024 * 1024,
          maxRedirects: 0,
        });
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
    // Used as a URL path segment — must be unguessable. The previous
    // shape mixed a predictable timestamp with Math.random and was
    // trivially enumerable.
    return crypto.randomBytes(16).toString('hex');
  }
}