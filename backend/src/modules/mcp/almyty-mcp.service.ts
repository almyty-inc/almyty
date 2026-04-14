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
  { name: 'import_schema', description: 'Import schema + generate tools', inputSchema: { type: 'object', properties: { apiId: { type: 'string' }, schemaUrl: { type: 'string' }, generateTools: { type: 'boolean' } }, required: ['apiId', 'schemaUrl'] } },
  { name: 'list_tools', description: 'List all tools', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_gateways', description: 'List all gateways', inputSchema: { type: 'object', properties: {} } },
  { name: 'create_gateway', description: 'Create a gateway (MCP/A2A/UTCP/Skills)', inputSchema: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string', enum: ['mcp', 'a2a', 'utcp', 'skills'] }, endpoint: { type: 'string' } }, required: ['name', 'type', 'endpoint'] } },
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
      case 'list_apis': return get(ApisService).findAllByOrganization(orgId);
      case 'create_api': return get(ApisService).create({ ...args, organizationId: orgId, userId });
      case 'import_schema': {
        // Fetch schema content from URL, then pass to importSchema
        const schemaRes = await axios.get(args.schemaUrl, { timeout: 30000 });
        const content = typeof schemaRes.data === 'string' ? schemaRes.data : JSON.stringify(schemaRes.data);
        return get(ApisService).importSchema(args.apiId, content, orgId, { generateTools: args.generateTools !== false });
      }
      case 'list_tools': return get(ToolsService).getTools({ organizationId: orgId });
      case 'list_gateways': return get(GatewaysService).getGateways({ organizationId: orgId });
      case 'create_gateway': return get(GatewaysService).createGateway({ ...args, kind: 'tool', configuration: { transport: 'http' } }, orgId, userId);
      case 'list_agents': return get(AgentsService).getAgents({ organizationId: orgId });
      case 'create_agent': return get(AgentsService).createAgent({ ...args }, orgId, userId);
      case 'list_providers': return get(LlmProvidersService).getProviders({ organizationId: orgId });
      case 'add_provider': return get(LlmProvidersService).createProvider({ name: args.name, type: args.type, configuration: { apiKey: args.apiKey } }, orgId, userId);
      default: throw new Error(`Unknown tool: ${name}`);
    }
  }
}
