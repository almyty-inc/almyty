import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Request,
  UseGuards,
  HttpException,
  HttpStatus,
  Logger,
  Header,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { A2AService } from '../a2a.service';
import {
  A2AAgent,
  A2AAgentType,
  A2AMessage,
  A2AMessageType,
  A2ASession,
  A2AToolRegistration,
  A2ADiscoveryInfo,
} from '../types/a2a.types';

@Controller('a2a')
@UseGuards(JwtAuthGuard)
export class A2AController {
  private readonly logger = new Logger(A2AController.name);

  constructor(private readonly a2aService: A2AService) {}

  // A2A Discovery
  @Get('/.well-known/a2a')
  @Header('Content-Type', 'application/json')
  async discovery(): Promise<A2ADiscoveryInfo> {
    const baseUrl = process.env.BASE_URL || 'http://localhost:4000';
    
    return {
      protocol: 'a2a',
      version: '1.0.0',
      server: {
        name: 'almyty',
        version: '1.0.0',
        description: 'Universal API-to-AI Tool Translation Platform with enhanced A2A support',
      },
      endpoints: {
        agents: `${baseUrl}/api/a2a/agents`,
        sessions: `${baseUrl}/api/a2a/sessions`,
        messages: `${baseUrl}/api/a2a/messages`,
        workflows: `${baseUrl}/api/a2a/workflows`,
        discovery: `${baseUrl}/api/a2a/.well-known/a2a`,
      },
      capabilities: {
        agentTypes: Object.values(A2AAgentType),
        messageTypes: Object.values(A2AMessageType),
        authentication: ['api_key', 'bearer', 'oauth2', 'custom'],
        transports: ['http', 'websocket'],
        features: [
          'agent_registration',
          'message_routing',
          'workflow_orchestration',
          'tool_integration',
          'real_time_communication',
          'agent_clustering',
          'performance_monitoring',
        ],
      },
      experimental: {
        almyty: {
          universalApiTranslation: true,
          workflowOrchestration: true,
          multiProtocolBridge: true,
        },
      },
    };
  }

  // Agent Management
  @Post('/agents')
  async registerAgent(@Request() req, @Body() agentData: any): Promise<A2AAgent> {
    const organizationId = req.user?.currentOrganizationId;
    
    if (!organizationId) {
      throw new HttpException('Organization context required', HttpStatus.BAD_REQUEST);
    }

    return this.a2aService.registerAgent(organizationId, agentData);
  }

  @Get('/agents')
  async listAgents(@Request() req): Promise<A2AAgent[]> {
    const organizationId = req.user?.currentOrganizationId;
    
    if (!organizationId) {
      throw new HttpException('Organization context required', HttpStatus.BAD_REQUEST);
    }

    return this.a2aService.listAgents(organizationId);
  }

  @Get('/agents/:agentId')
  async getAgent(@Param('agentId') agentId: string, @Request() req): Promise<A2AAgent> {
    const agent = await this.a2aService.getAgent(agentId);
    
    if (!agent) {
      throw new HttpException('Agent not found', HttpStatus.NOT_FOUND);
    }

    // Verify access
    if (agent.organizationId !== req.user?.currentOrganizationId) {
      throw new HttpException('Access denied', HttpStatus.FORBIDDEN);
    }

    return agent;
  }

  @Put('/agents/:agentId')
  async updateAgent(
    @Param('agentId') agentId: string,
    @Body() updates: Partial<A2AAgent>,
    @Request() req,
  ): Promise<A2AAgent> {
    const agent = await this.getAgent(agentId, req);
    
    const updatedAgent = await this.a2aService.updateAgent(agentId, updates);
    if (!updatedAgent) {
      throw new HttpException('Failed to update agent', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    return updatedAgent;
  }

  @Delete('/agents/:agentId')
  async deregisterAgent(@Param('agentId') agentId: string, @Request() req): Promise<void> {
    const agent = await this.getAgent(agentId, req);
    
    const success = await this.a2aService.deregisterAgent(agentId);
    if (!success) {
      throw new HttpException('Failed to deregister agent', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // Message Management
  @Post('/messages')
  async sendMessage(@Request() req, @Body() messageData: {
    fromAgentId?: string;
    toAgentId: string;
    content: any;
    type?: A2AMessageType;
    context?: any;
  }): Promise<A2AMessage> {
    const organizationId = req.user?.currentOrganizationId;

    if (!organizationId) {
      throw new HttpException('Organization context required', HttpStatus.BAD_REQUEST);
    }

    const fromAgentId = messageData.fromAgentId || 'user_agent';

    return this.a2aService.sendMessage(
      fromAgentId,
      messageData.toAgentId,
      messageData.content,
      messageData.type,
      messageData.context,
      organizationId,
    );
  }

  @Get('/messages/:agentId')
  async getAgentMessages(
    @Param('agentId') agentId: string,
    @Query('limit') limit: string,
    @Request() req,
  ): Promise<A2AMessage[]> {
    // Verify agent access
    await this.getAgent(agentId, req);

    const messageLimit = limit ? parseInt(limit, 10) : 50;
    return this.a2aService.getAgentMessages(agentId, messageLimit);
  }

  // Session Management
  @Post('/sessions')
  async createSession(@Request() req, @Body() sessionData: {
    participantAgentIds: string[];
    metadata?: any;
  }): Promise<A2ASession> {
    const organizationId = req.user?.currentOrganizationId;
    
    if (!organizationId) {
      throw new HttpException('Organization context required', HttpStatus.BAD_REQUEST);
    }

    return this.a2aService.createSession(
      organizationId,
      sessionData.participantAgentIds,
      sessionData.metadata,
    );
  }

  @Get('/sessions/:sessionId')
  async getSession(@Param('sessionId') sessionId: string, @Request() req): Promise<A2ASession> {
    const session = await this.a2aService.getSession(sessionId);
    
    if (!session) {
      throw new HttpException('Session not found', HttpStatus.NOT_FOUND);
    }

    // Verify access
    if (session.organizationId !== req.user?.currentOrganizationId) {
      throw new HttpException('Access denied', HttpStatus.FORBIDDEN);
    }

    return session;
  }

  // Tool Registration for Agents
  @Post('/agents/:agentId/tools')
  async registerAgentTool(
    @Param('agentId') agentId: string,
    @Body() toolRegistration: A2AToolRegistration,
    @Request() req,
  ) {
    // Verify agent access
    await this.getAgent(agentId, req);

    return this.a2aService.registerAgentTool(agentId, toolRegistration);
  }

  // Workflow Orchestration
  @Post('/workflows')
  async createWorkflow(@Request() req, @Body() workflow: any): Promise<{ workflowId: string }> {
    const organizationId = req.user?.currentOrganizationId;
    
    if (!organizationId) {
      throw new HttpException('Organization context required', HttpStatus.BAD_REQUEST);
    }

    const workflowId = await this.a2aService.orchestrateAgents(organizationId, workflow);
    
    return { workflowId };
  }

  // Agent Discovery and Health
  @Get('/discover')
  async discoverAgents(@Request() req): Promise<A2AAgent[]> {
    const organizationId = req.user?.currentOrganizationId;
    
    if (!organizationId) {
      throw new HttpException('Organization context required', HttpStatus.BAD_REQUEST);
    }

    return this.a2aService.discoverAgents(organizationId);
  }

  // Advanced Features
  @Post('/clusters')
  async createAgentCluster(@Request() req, @Body() clusterData: any): Promise<{ clusterId: string }> {
    const organizationId = req.user?.currentOrganizationId;
    
    if (!organizationId) {
      throw new HttpException('Organization context required', HttpStatus.BAD_REQUEST);
    }

    const clusterId = await this.a2aService.createAgentCluster(organizationId, clusterData);
    
    return { clusterId };
  }

  @Get('/agents/:agentId/metrics')
  async getAgentMetrics(@Param('agentId') agentId: string, @Request() req) {
    // Verify agent access
    await this.getAgent(agentId, req);
    
    return this.a2aService.getAgentMetrics(agentId);
  }

  // Statistics
  @Get('/stats')
  async getA2AStats(@Request() req) {
    const organizationId = req.user?.currentOrganizationId;
    
    if (!organizationId) {
      throw new HttpException('Organization context required', HttpStatus.BAD_REQUEST);
    }

    return this.a2aService.getA2AStats(organizationId);
  }

  // Health check
  @Get('/health')
  async health() {
    return {
      protocol: 'a2a',
      status: 'healthy',
      server: 'almyty',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      features: {
        agentRegistration: true,
        messageRouting: true,
        workflowOrchestration: true,
        realTimeCommunication: true,
        agentClustering: true,
        performanceMonitoring: true,
      },
    };
  }

  // Agent Types and Capabilities
  @Get('/capabilities')
  async getCapabilities() {
    return {
      protocol: 'a2a',
      version: '1.0.0',
      supportedAgentTypes: Object.values(A2AAgentType),
      supportedMessageTypes: Object.values(A2AMessageType),
      features: [
        'Agent registration and discovery',
        'Message routing and delivery', 
        'Session management',
        'Authentication and security',
        'Health monitoring',
        'Metrics collection',
        'Workflow orchestration',
        'Agent clustering and load balancing',
        'Universal API integration',
        'Multi-protocol bridge',
      ],
    };
  }
}