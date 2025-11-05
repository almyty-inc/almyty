import {
  Controller,
  Get,
  Header,
} from '@nestjs/common';

@Controller()
export class PublicController {
  
  // A2A Discovery (public endpoint)
  @Get('/a2a/.well-known/a2a')
  @Header('Content-Type', 'application/json')
  async a2aDiscovery() {
    const baseUrl = process.env.BASE_URL || 'http://localhost:4000';
    
    return {
      protocol: 'a2a',
      version: '1.0.0',
      server: {
        name: 'apifai',
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
        agentTypes: ['openai', 'anthropic', 'google', 'cohere', 'custom_llm', 'tool_agent', 'function_agent', 'workflow_agent'],
        messageTypes: ['request', 'response', 'notification', 'function_call', 'function_result', 'tool_invocation', 'tool_result', 'workflow_start', 'workflow_step', 'workflow_complete'],
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
        apifai: {
          universalApiTranslation: true,
          workflowOrchestration: true,
          multiProtocolBridge: true,
        },
      },
    };
  }

  // A2A Capabilities (public endpoint)
  @Get('/a2a/capabilities')
  @Header('Content-Type', 'application/json')
  async a2aCapabilities() {
    return {
      protocol: 'a2a',
      version: '1.0.0',
      supportedAgentTypes: ['openai', 'anthropic', 'google', 'cohere', 'custom_llm', 'tool_agent', 'function_agent', 'workflow_agent'],
      supportedMessageTypes: ['request', 'response', 'notification', 'function_call', 'function_result', 'tool_invocation', 'tool_result', 'workflow_start', 'workflow_step', 'workflow_complete'],
      features: [
        'Agent registration and discovery',
        'Message routing and delivery',
        'Session management', 
        'Authentication and security',
        'Health monitoring',
        'Metrics collection',
        'Universal API integration',
        'Multi-protocol bridge',
        'Workflow orchestration',
        'Agent clustering and load balancing',
      ],
    };
  }

  // A2A Health (public endpoint)
  @Get('/a2a/health')
  async a2aHealth() {
    return {
      protocol: 'a2a',
      status: 'healthy',
      server: 'apifai',
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
}