/**
 * AlmytyMcpService — serves almyty platform management as native MCP tools.
 * Pure code. No DB entries. Tool definitions are inline. Execution calls
 * existing NestJS services via ModuleRef. Mounted at POST /mcp/almyty.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import axios from 'axios';
import { JsonRpcResponse } from './types/mcp.types';
import { ApisService } from '../apis/apis.service';
import { ToolsService } from '../tools/tools.service';
import { GatewaysService } from '../gateways/gateways.service';
import { AgentsService } from '../agents/agents.service';
import { LlmProvidersService } from '../llm-providers/llm-providers.service';

const TOOLS = [
  { name: 'list_apis', description: 'List all connected APIs', inputSchema: { type: 'object', properties: {} } },
  { name: 'create_api', description: 'Connect a new API', inputSchema: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string', enum: ['openapi', 'graphql', 'soap', 'protobuf', 'sdk'] }, baseUrl: { type: 'string' } }, required: ['name', 'type'] } },
  { name: 'import_schema', description: 'Import schema + generate tools (async — returns a jobId)', inputSchema: { type: 'object', properties: { apiId: { type: 'string' }, schemaUrl: { type: 'string' }, generateTools: { type: 'boolean' } }, required: ['apiId', 'schemaUrl'] } },
  { name: 'check_import_status', description: 'Check the status of a schema import job', inputSchema: { type: 'object', properties: { jobId: { type: 'string', description: 'Job ID returned by import_schema' } }, required: ['jobId'] } },
  { name: 'delete_api', description: 'Delete an API by ID', inputSchema: { type: 'object', properties: { apiId: { type: 'string', description: 'API ID to delete' } }, required: ['apiId'] } },
  { name: 'list_tools', description: 'List all tools', inputSchema: { type: 'object', properties: {} } },
  { name: 'delete_tool', description: 'Delete a tool by ID', inputSchema: { type: 'object', properties: { toolId: { type: 'string', description: 'Tool ID to delete' } }, required: ['toolId'] } },
  { name: 'list_gateways', description: 'List all gateways', inputSchema: { type: 'object', properties: {} } },
  { name: 'delete_gateway', description: 'Delete a gateway by ID', inputSchema: { type: 'object', properties: { gatewayId: { type: 'string', description: 'Gateway ID to delete' } }, required: ['gatewayId'] } },
  { name: 'create_gateway', description: 'Create a gateway with auth and tools. Endpoint and auth (API key) are auto-configured. By default assigns ALL tools unless you specify toolIds or apiIds to scope it.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string', enum: ['mcp', 'a2a', 'utcp', 'skills'] }, endpoint: { type: 'string', description: 'URL slug. Auto-generated from name if omitted.' }, toolIds: { type: 'array', items: { type: 'string' }, description: 'Specific tool IDs to assign' }, apiIds: { type: 'array', items: { type: 'string' }, description: 'Assign all tools from these API IDs' }, assignTools: { type: 'boolean', description: 'Auto-assign all org tools if no toolIds/apiIds given. Default: true' } }, required: ['name', 'type'] } },
  { name: 'assign_tools_to_gateway', description: 'Assign tools to a gateway by tool IDs or by API name (assigns all tools from that API)', inputSchema: { type: 'object', properties: { gatewayId: { type: 'string' }, toolIds: { type: 'array', items: { type: 'string' }, description: 'Tool IDs to assign' }, apiName: { type: 'string', description: 'Assign all tools from this API (by name)' } }, required: ['gatewayId'] } },
  { name: 'add_auth_to_gateway', description: 'Add an auth method to a gateway', inputSchema: { type: 'object', properties: { gatewayId: { type: 'string' }, type: { type: 'string', enum: ['api_key', 'bearer_token', 'basic_auth', 'oauth2', 'jwt', 'none'], description: 'Auth type to add' } }, required: ['gatewayId', 'type'] } },
  { name: 'remove_auth_from_gateway', description: 'Remove an auth method from a gateway', inputSchema: { type: 'object', properties: { gatewayId: { type: 'string' }, authId: { type: 'string', description: 'Auth config ID to remove' } }, required: ['gatewayId', 'authId'] } },
  { name: 'list_agents', description: 'List all agents', inputSchema: { type: 'object', properties: {} } },
  { name: 'create_agent', description: 'Create an agent', inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, mode: { type: 'string', enum: ['workflow', 'autonomous'] }, instructions: { type: 'string' } }, required: ['name'] } },
  { name: 'list_providers', description: 'List LLM providers', inputSchema: { type: 'object', properties: {} } },
  { name: 'add_provider', description: 'Add an LLM provider', inputSchema: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string' }, apiKey: { type: 'string' } }, required: ['name', 'type', 'apiKey'] } },
];

@Injectable()
export class AlmytyMcpService {
  private readonly logger = new Logger(AlmytyMcpService.name);
  constructor(private readonly moduleRef: ModuleRef) {}

  async handleJsonRpc(body: any, organizationId: string, userId: string): Promise<JsonRpcResponse> {
    const { method, id, params } = body;
    switch (method) {
      case 'initialize':
        return { jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'almyty', version: '1.0.0' } } };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
      case 'tools/call':
        return this.callTool(id, params?.name, params?.arguments || {}, organizationId, userId);
      case 'resources/list':
        return { jsonrpc: '2.0', id, result: { resources: [] } };
      case 'resources/read':
        return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Resource not found' } };
      case 'prompts/list':
        return { jsonrpc: '2.0', id, result: { prompts: [] } };
      case 'prompts/get':
        return { jsonrpc: '2.0', id, result: { messages: [{ role: 'user', content: { type: 'text', text: params?.name || '' } }] } };
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'notifications/initialized':
        return { jsonrpc: '2.0', id, result: {} };
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
  }

  private async callTool(id: any, name: string, args: any, orgId: string, userId: string): Promise<JsonRpcResponse> {
    try {
      const result = await this.exec(name, args, orgId, userId);
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } };
    } catch (err: any) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true } };
    }
  }

  private async exec(name: string, args: any, orgId: string, userId: string): Promise<any> {
    const get = <T>(cls: new (...a: any[]) => T): T => this.moduleRef.get(cls, { strict: false });
    switch (name) {
      case 'list_apis': {
        const { apis, total } = await get(ApisService).findAllByOrganization(orgId, { limit: 50 });
        return { total, apis: apis.map(a => ({ id: a.id, name: a.name, type: a.type, status: a.status, baseUrl: a.baseUrl })) };
      }
      case 'create_api': return get(ApisService).create({ ...args, organizationId: orgId, userId });
      case 'import_schema': {
        // Fetch schema content from URL
        const schemaRes = await axios.get(args.schemaUrl, { timeout: 30000 });
        const content = typeof schemaRes.data === 'string' ? schemaRes.data : JSON.stringify(schemaRes.data);
        // Queue async import via BullMQ (same as the REST API does)
        const { Queue } = require('bull');
        const queue = this.moduleRef.get('BullQueue_schema-import', { strict: false });
        const job = await queue.add('import', {
          apiId: args.apiId,
          organizationId: orgId,
          schemaContent: content,
          options: { generateTools: args.generateTools !== false },
        }, { timeout: 5 * 60 * 1000, removeOnComplete: 100, removeOnFail: 50 });
        return { jobId: job.id, status: 'queued', message: `Schema import queued (job ${job.id}). Tools will be generated in the background.` };
      }
      case 'check_import_status': {
        const queue = this.moduleRef.get('BullQueue_schema-import', { strict: false });
        const job = await queue.getJob(args.jobId);
        if (!job) return { error: `Job ${args.jobId} not found` };
        const state = await job.getState();
        return { jobId: args.jobId, state, failedReason: job.failedReason || null, progress: job.progress || 0 };
      }
      case 'delete_api': return get(ApisService).remove(args.apiId, orgId);
      case 'list_tools': {
        const toolResult = await get(ToolsService).getTools({ organizationId: orgId, limit: 100 });
        const tools = Array.isArray(toolResult) ? toolResult : (toolResult as any).tools || [];
        return { total: (toolResult as any).total || tools.length, tools: tools.map((t: any) => ({ id: t.id, name: t.name, type: t.type, status: t.status, description: t.description?.substring(0, 100) })) };
      }
      case 'delete_tool': return get(ToolsService).deleteTool(args.toolId, orgId, userId);
      case 'list_gateways': {
        const gwResult = await get(GatewaysService).getGateways({ organizationId: orgId, limit: 50 });
        return { total: gwResult.total, gateways: gwResult.gateways.map(g => ({ id: g.id, name: g.name, type: g.type, kind: g.kind, status: g.status, endpoint: g.endpoint, isSystem: g.isSystem })) };
      }
      case 'delete_gateway': return get(GatewaysService).deleteGateway(args.gatewayId, orgId, userId);
      case 'create_gateway': {
        const endpoint = args.endpoint || `/${args.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
        const gateway = await get(GatewaysService).createGateway({ ...args, endpoint, kind: 'tool', configuration: { transport: 'http' } }, orgId, userId);

        // Assign tools
        let assignedCount = 0;
        const shouldAssign = args.assignTools !== false; // default true
        if (shouldAssign) {
          try {
            const GatewayToolService = require('../gateways/gateway-tool.service').GatewayToolService;
            const gwToolService = this.moduleRef.get(GatewayToolService, { strict: false });
            const toolResult = await get(ToolsService).getTools({ organizationId: orgId, limit: 500 });
            const allTools = Array.isArray(toolResult) ? toolResult : (toolResult as any).tools || [];

            let toolIds: string[] = [];
            if (args.toolIds?.length) {
              // Explicit tool IDs
              toolIds = args.toolIds;
            } else if (args.apiIds?.length) {
              // All tools from specific APIs
              toolIds = allTools.filter((t: any) => args.apiIds.includes(t.apiId)).map((t: any) => t.id);
            } else {
              // Default: all org tools
              toolIds = allTools.map((t: any) => t.id);
            }

            if (toolIds.length > 0) {
              await gwToolService.bulkAssociateTools(gateway.id, { toolIds }, orgId, userId);
              assignedCount = toolIds.length;
            }
          } catch (e) {
            this.logger.warn(`Tool assignment failed: ${e.message}`);
          }
        }

        return { id: gateway.id, name: gateway.name, endpoint: gateway.endpoint, type: gateway.type, toolsAssigned: assignedCount };
      }
      case 'assign_tools_to_gateway': {
        const GatewayToolService = require('../gateways/gateway-tool.service').GatewayToolService;
        const gwToolService = this.moduleRef.get(GatewayToolService, { strict: false });
        let toolIds: string[] = args.toolIds || [];
        if (args.apiName && toolIds.length === 0) {
          // Find all tools from this API by name
          const toolResult = await get(ToolsService).getTools({ organizationId: orgId, limit: 500 });
          const tools = Array.isArray(toolResult) ? toolResult : (toolResult as any).tools || [];
          const apiTools = tools.filter((t: any) => t.api?.name?.toLowerCase() === args.apiName.toLowerCase() || t.name?.toLowerCase().startsWith(args.apiName.toLowerCase().replace(/[^a-z0-9]/g, '_')));
          toolIds = apiTools.map((t: any) => t.id);
        }
        if (toolIds.length === 0) return { error: 'No tools found to assign' };
        const result = await gwToolService.bulkAssociateTools(args.gatewayId, { toolIds }, orgId, userId);
        return { assigned: toolIds.length, gatewayId: args.gatewayId };
      }
      case 'add_auth_to_gateway': {
        const GatewayAuthService = require('../gateways/gateway-auth.service').GatewayAuthService;
        const gwAuthService = this.moduleRef.get(GatewayAuthService, { strict: false });
        const config: Record<string, any> = {};
        if (args.type === 'api_key') { config.keyHeader = 'x-api-key'; config.keyQuery = 'api_key'; }
        const auth = await gwAuthService.createGatewayAuth(args.gatewayId, { type: args.type, configuration: config }, orgId);
        return { id: auth.id, type: auth.type, gatewayId: args.gatewayId };
      }
      case 'remove_auth_from_gateway': {
        const GatewayAuthService = require('../gateways/gateway-auth.service').GatewayAuthService;
        const gwAuthService = this.moduleRef.get(GatewayAuthService, { strict: false });
        await gwAuthService.deleteGatewayAuth(args.authId, orgId);
        return { deleted: true, authId: args.authId };
      }
      case 'list_agents': {
        const agResult = await get(AgentsService).getAgents({ organizationId: orgId, limit: 50 });
        const agents = Array.isArray(agResult) ? agResult : (agResult as any).agents || [];
        return { total: (agResult as any).total || agents.length, agents: agents.map((a: any) => ({ id: a.id, name: a.name, mode: a.mode, status: a.status })) };
      }
      case 'create_agent': return get(AgentsService).createAgent({ ...args }, orgId, userId);
      case 'list_providers': return get(LlmProvidersService).getProviders({ organizationId: orgId });
      case 'add_provider': return get(LlmProvidersService).createProvider({ name: args.name, type: args.type, configuration: { apiKey: args.apiKey } }, orgId, userId);
      default: throw new Error(`Unknown tool: ${name}`);
    }
  }
}
