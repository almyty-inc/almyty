/**
 * AlmytyMcpService — serves almyty platform management as native MCP tools.
 * Pure code. No DB entries. Tool definitions are inline. Execution calls
 * existing NestJS services via ModuleRef. Mounted at POST /:org/almyty.
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
import { CanonicalMemoryService } from '../memory/canonical/canonical-memory.service';
import {
  MemoryError,
  Mode,
  Tier,
  ScopeType,
  Provenance,
} from '../memory/canonical/canonical.types';
import { ConsolidationService } from '../memory/canonical/consolidation.service';
import { MemoryRouter } from '../memory/canonical/memory-router.service';
import { MemorySyncService } from '../memory/canonical/memory-sync.service';

const TOOLS = [
  { name: 'list_apis', description: 'List all connected APIs', inputSchema: { type: 'object', properties: {} } },
  { name: 'create_api', description: 'Connect a new API. Pass `authentication` to set auth (e.g. {type:"api_key",config:{parameter:"X-Key",location:"header",apiKey:"..."}}).', inputSchema: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string', enum: ['openapi', 'graphql', 'soap', 'protobuf', 'sdk'] }, baseUrl: { type: 'string' }, authentication: { type: 'object', description: 'API auth: {type, config}', additionalProperties: true } }, required: ['name', 'type'] } },
  { name: 'update_api', description: 'Update an existing API. Use to change baseUrl, headers, authentication, or rateLimits without deleting.', inputSchema: { type: 'object', properties: { apiId: { type: 'string' }, name: { type: 'string' }, baseUrl: { type: 'string' }, headers: { type: 'object', additionalProperties: true }, authentication: { type: 'object', description: 'API auth: {type, config}', additionalProperties: true }, rateLimits: { type: 'object', additionalProperties: true } }, required: ['apiId'] } },
  { name: 'import_schema', description: 'Import schema + generate tools (async — returns a jobId). Pass either schemaUrl OR schemaContent.', inputSchema: { type: 'object', properties: { apiId: { type: 'string' }, schemaUrl: { type: 'string' }, schemaContent: { type: 'string', description: 'Inline schema content (use instead of schemaUrl)' }, generateTools: { type: 'boolean' } }, required: ['apiId'] } },
  { name: 'check_import_status', description: 'Check the status of a schema import job', inputSchema: { type: 'object', properties: { jobId: { type: 'string', description: 'Job ID returned by import_schema' } }, required: ['jobId'] } },
  { name: 'delete_api', description: 'Delete an API by ID', inputSchema: { type: 'object', properties: { apiId: { type: 'string', description: 'API ID to delete' } }, required: ['apiId'] } },
  { name: 'list_tools', description: 'List all tools', inputSchema: { type: 'object', properties: {} } },
  { name: 'delete_tool', description: 'Delete a tool by ID', inputSchema: { type: 'object', properties: { toolId: { type: 'string', description: 'Tool ID to delete' } }, required: ['toolId'] } },
  { name: 'list_gateways', description: 'List all gateways', inputSchema: { type: 'object', properties: {} } },
  { name: 'delete_gateway', description: 'Delete a gateway by ID', inputSchema: { type: 'object', properties: { gatewayId: { type: 'string', description: 'Gateway ID to delete' } }, required: ['gatewayId'] } },
  { name: 'create_gateway', description: 'Create a gateway. For agent-kind types (a2a, acp, openai_chat), pass agentId. For tool-kind types (mcp, utcp, skills), tools are auto-assigned.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string', enum: ['mcp', 'a2a', 'acp', 'utcp', 'skills', 'openai_chat'] }, endpoint: { type: 'string', description: 'URL slug. Auto-generated from name if omitted.' }, agentId: { type: 'string', description: 'Agent ID for agent-kind gateways (a2a, acp, openai_chat)' }, toolIds: { type: 'array', items: { type: 'string' }, description: 'Specific tool IDs to assign (tool-kind only)' }, apiIds: { type: 'array', items: { type: 'string' }, description: 'Assign all tools from these API IDs (tool-kind only)' }, assignTools: { type: 'boolean', description: 'Auto-assign all org tools if no toolIds/apiIds given. Default: true for tool-kind.' }, configuration: { type: 'object', description: 'Gateway-type-specific config. MCP: {transport: http|sse|websocket}. UTCP: {protocol: http|tcp}. Defaults are sensible per type.', additionalProperties: true } }, required: ['name', 'type'] } },
  { name: 'assign_tools_to_gateway', description: 'Assign tools to a gateway by tool IDs or by API name (assigns all tools from that API)', inputSchema: { type: 'object', properties: { gatewayId: { type: 'string' }, toolIds: { type: 'array', items: { type: 'string' }, description: 'Tool IDs to assign' }, apiName: { type: 'string', description: 'Assign all tools from this API (by name)' } }, required: ['gatewayId'] } },
  { name: 'add_auth_to_gateway', description: 'Add an auth method to a gateway', inputSchema: { type: 'object', properties: { gatewayId: { type: 'string' }, type: { type: 'string', enum: ['api_key', 'bearer_token', 'basic_auth', 'oauth2', 'jwt', 'none'], description: 'Auth type to add' } }, required: ['gatewayId', 'type'] } },
  { name: 'remove_auth_from_gateway', description: 'Remove an auth method from a gateway', inputSchema: { type: 'object', properties: { gatewayId: { type: 'string' }, authId: { type: 'string', description: 'Auth config ID to remove' } }, required: ['gatewayId', 'authId'] } },
  { name: 'list_agents', description: 'List all agents', inputSchema: { type: 'object', properties: {} } },
  { name: 'create_agent', description: 'Create an agent', inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, mode: { type: 'string', enum: ['workflow', 'autonomous'] }, instructions: { type: 'string' } }, required: ['name'] } },
  { name: 'list_providers', description: 'List LLM providers', inputSchema: { type: 'object', properties: {} } },
  { name: 'add_provider', description: 'Add an LLM provider', inputSchema: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string' }, apiKey: { type: 'string' } }, required: ['name', 'type', 'apiKey'] } },
  // ── Memory (canonical schema v1) ──────────────────────────────
  { name: 'memory_put', description: 'Write a memory or document item. memory mode = agent-written facts/preferences; document mode = chunked imported text.', inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['memory', 'document'] }, scope_type: { type: 'string', enum: ['user', 'workspace', 'project', 'collab'], description: 'Defaults to workspace if omitted.' }, scope_id: { type: 'string', description: 'Defaults to the calling organization id when scope_type=workspace.' }, content: { type: 'string' }, tier: { type: 'string', enum: ['short', 'project', 'long', 'shared'], description: 'Memory mode only. Defaults to short.' }, tags: { type: 'array', items: { type: 'string' } }, ttl_seconds: { type: 'number' }, source_uri: { type: 'string', description: 'Document mode: where the text came from.' }, source_version: { type: 'number' } }, required: ['mode', 'content'] } },
  { name: 'memory_search', description: 'Hybrid (vector + FTS) search across a scope.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, scope_type: { type: 'string', enum: ['user', 'workspace', 'project', 'collab'] }, scope_id: { type: 'string' }, mode: { type: 'string', enum: ['memory', 'document'] }, tier: { type: 'string', enum: ['short', 'project', 'long', 'shared'] }, top_k: { type: 'number' }, fts_only: { type: 'boolean' } }, required: ['query'] } },
  { name: 'memory_list', description: 'List memory items in a scope (newest first).', inputSchema: { type: 'object', properties: { scope_type: { type: 'string', enum: ['user', 'workspace', 'project', 'collab'] }, scope_id: { type: 'string' }, mode: { type: 'string', enum: ['memory', 'document'] }, tier: { type: 'string', enum: ['short', 'project', 'long', 'shared'] }, tags: { type: 'array', items: { type: 'string' } }, include_superseded: { type: 'boolean' }, include_deleted: { type: 'boolean' }, limit: { type: 'number' }, cursor: { type: 'string' } } } },
  { name: 'memory_get', description: 'Get a single memory item by id.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'memory_delete', description: 'Delete a memory item. mode=soft (default) sets deleted_at; mode=hard removes the row.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, mode: { type: 'string', enum: ['soft', 'hard'] } }, required: ['id'] } },
  { name: 'memory_supersede', description: 'Bi-temporal supersession (memory mode only): close valid_until on the old row and write a new one with the same logical content.', inputSchema: { type: 'object', properties: { old_id: { type: 'string' }, content: { type: 'string' }, tier: { type: 'string', enum: ['short', 'project', 'long', 'shared'] }, tags: { type: 'array', items: { type: 'string' } } }, required: ['old_id', 'content'] } },
  { name: 'memory_consolidate', description: 'Run consolidation now: LLM extracts durable facts from short-tier rows and supersedes them. Returns the run report.', inputSchema: { type: 'object', properties: { scope_type: { type: 'string', enum: ['user', 'workspace', 'project', 'collab'] }, scope_id: { type: 'string' }, force: { type: 'boolean', description: 'Bypass enabled-flag and min_short_count thresholds.' } } } },
  { name: 'memory_transfer', description: 'Move memory items from one backend to another for a scope. Returns a TransferReport with capability-degradation warnings.', inputSchema: { type: 'object', properties: { scope_type: { type: 'string', enum: ['user', 'workspace', 'project', 'collab'] }, scope_id: { type: 'string' }, source: { type: 'string', description: 'Source backend id (almyty-native, mem0, zep, supermemory, vertex-memory-bank, anthropic-memory-tool)' }, target: { type: 'string' }, mode: { type: 'string', enum: ['memory', 'document'] }, dry_run: { type: 'boolean' } }, required: ['source', 'target'] } },
  { name: 'memory_sync', description: 'Reconcile primary↔mirror for a scope. Last-write-wins by updated_at. Returns counts moved each direction.', inputSchema: { type: 'object', properties: { scope_type: { type: 'string', enum: ['user', 'workspace', 'project', 'collab'] }, scope_id: { type: 'string' } } } },
  { name: 'memory_list_backends', description: 'List configured memory backends + capabilities + supported modes.', inputSchema: { type: 'object', properties: {} } },
  { name: 'memory_backends_health', description: 'Run a health check against every backend.', inputSchema: { type: 'object', properties: {} } },
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
        // Either schemaContent or schemaUrl must be supplied. Inline
        // content is the path callers want when they're crafting a
        // throwaway schema in-process; URL is the more common one.
        let content: string;
        if (args.schemaContent) {
          content = String(args.schemaContent);
        } else if (args.schemaUrl) {
          const schemaRes = await axios.get(args.schemaUrl, { timeout: 30000 });
          content = typeof schemaRes.data === 'string' ? schemaRes.data : JSON.stringify(schemaRes.data);
        } else {
          throw new Error('import_schema requires either schemaUrl or schemaContent');
        }
        const queue = this.moduleRef.get('BullQueue_schema-import', { strict: false });
        const job = await queue.add('import', {
          apiId: args.apiId,
          organizationId: orgId,
          schemaContent: content,
          options: { generateTools: args.generateTools !== false },
        }, { timeout: 5 * 60 * 1000, removeOnComplete: 100, removeOnFail: 50 });
        return { jobId: job.id, status: 'queued', message: `Schema import queued (job ${job.id}). Tools will be generated in the background.` };
      }
      case 'update_api': {
        const { apiId, ...patch } = args;
        const updated = await get(ApisService).update(apiId, patch, orgId);
        return { id: updated.id, name: updated.name, baseUrl: updated.baseUrl, authentication: updated.authentication };
      }
      case 'check_import_status': {
        const queue = this.moduleRef.get('BullQueue_schema-import', { strict: false });
        const job = await queue.getJob(args.jobId);
        if (!job) return { error: `Job ${args.jobId} not found` };
        const state = await job.getState();
        return { jobId: args.jobId, state, failedReason: job.failedReason || null, progress: job.progress || 0 };
      }
      case 'delete_api': {
        await get(ApisService).remove(args.apiId, orgId);
        return { deleted: true, apiId: args.apiId };
      }
      case 'list_tools': {
        const toolResult = await get(ToolsService).getTools({ organizationId: orgId, limit: 100 });
        const tools = Array.isArray(toolResult) ? toolResult : (toolResult as any).tools || [];
        return { total: (toolResult as any).total || tools.length, tools: tools.map((t: any) => ({ id: t.id, name: t.name, type: t.type, status: t.status, description: t.description?.substring(0, 100) })) };
      }
      case 'delete_tool': {
        await get(ToolsService).deleteTool(args.toolId, orgId, userId);
        return { deleted: true, toolId: args.toolId };
      }
      case 'list_gateways': {
        const gwResult = await get(GatewaysService).getGateways({ organizationId: orgId, limit: 50 });
        return { total: gwResult.total, gateways: gwResult.gateways.map(g => ({ id: g.id, name: g.name, type: g.type, kind: g.kind, status: g.status, endpoint: g.endpoint, isSystem: g.isSystem })) };
      }
      case 'delete_gateway': {
        await get(GatewaysService).deleteGateway(args.gatewayId, orgId, userId);
        return { deleted: true, gatewayId: args.gatewayId };
      }
      case 'create_gateway': {
        const endpoint = args.endpoint || `/${args.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
        const toolTypes = ['mcp', 'utcp', 'skills'];
        const isToolKind = toolTypes.includes(args.type);
        // Per-type default configuration. MCP requires `transport`, UTCP requires `protocol`.
        // A bare `{transport: http}` blocks UTCP gateway creation through this tool.
        const defaultConfigByType: Record<string, Record<string, any>> = {
          mcp: { transport: 'http' },
          utcp: { protocol: 'http' },
        };
        const configuration = args.configuration || defaultConfigByType[args.type] || {};
        const gatewayData: any = { ...args, endpoint, configuration };
        if (!isToolKind && args.agentId) gatewayData.agentId = args.agentId;
        const gateway = await get(GatewaysService).createGateway(gatewayData, orgId, userId);

        // Assign tools (only for tool-kind gateways)
        let assignedCount = 0;
        const shouldAssign = isToolKind && args.assignTools !== false;
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
        const agResult: any = await get(AgentsService).getAgents({ organizationId: orgId, limit: 50 });
        const agents = Array.isArray(agResult) ? agResult : (agResult?.data || agResult?.agents || []);
        return { total: agResult?.total || agResult?.pagination?.total || agents.length, agents: agents.map((a: any) => ({ id: a.id, name: a.name, mode: a.mode, status: a.status, slug: a.name?.toLowerCase().replace(/\s+/g, '-') })) };
      }
      case 'create_agent': return get(AgentsService).createAgent({ ...args }, orgId, userId);
      case 'list_providers': return get(LlmProvidersService).getProviders({ organizationId: orgId });
      case 'add_provider': return get(LlmProvidersService).createProvider({ name: args.name, type: args.type, configuration: { apiKey: args.apiKey } }, orgId, userId);

      // ── Memory (canonical) ─────────────────────────────────────
      case 'memory_put': {
        const memSvc = get(CanonicalMemoryService);
        const mode = args.mode as Mode;
        const scope_type = (args.scope_type as ScopeType) || 'workspace';
        const scope_id = args.scope_id || orgId;
        const provenance: Provenance = {
          agent_id: null,
          session_id: null,
          collab_id: null,
          model: null,
          provider: null,
          tool_chain: ['memory_put'],
          created_by: 'agent',
          source_backend: 'almyty-native',
        };
        try {
          const item = await memSvc.put(
            {
              mode,
              scope: { scope_type, scope_id },
              content: String(args.content),
              tier: mode === 'memory' ? ((args.tier as Tier) ?? 'short') : undefined,
              tags: args.tags,
              ttl_seconds: args.ttl_seconds ?? null,
              source_uri: args.source_uri,
              source_version: args.source_version,
              provenance,
            },
            { user_id: userId },
          );
          return {
            id: item.id,
            mode: item.mode,
            embedding_status: item.embedding_status,
            content_bytes: item.content_bytes,
            tier: item.tier,
          };
        } catch (err) {
          if (err instanceof MemoryError) return { error: err.tag };
          throw err;
        }
      }
      case 'memory_search': {
        const ranked = await get(CanonicalMemoryService).search({
          scope: {
            scope_type: (args.scope_type as ScopeType) || 'workspace',
            scope_id: args.scope_id || orgId,
          },
          query: String(args.query),
          mode: args.mode,
          tier: args.tier,
          tags: args.tags,
          top_k: args.top_k ?? 10,
          fts_only: args.fts_only ?? false,
        });
        return ranked.map((r) => ({
          id: r.item.id,
          score: r.score,
          signal: r.signal,
          content: r.item.content,
          tier: r.item.tier,
          tags: r.item.tags,
          mode: r.item.mode,
        }));
      }
      case 'memory_list': {
        const page = await get(CanonicalMemoryService).list({
          scope: {
            scope_type: (args.scope_type as ScopeType) || 'workspace',
            scope_id: args.scope_id || orgId,
          },
          mode: args.mode,
          tier: args.tier,
          tags: args.tags,
          include_superseded: args.include_superseded,
          include_deleted: args.include_deleted,
          limit: args.limit ?? 50,
          cursor: args.cursor ?? null,
        });
        return {
          total: page.total,
          cursor: page.cursor,
          items: page.items.map((i) => ({
            id: i.id,
            mode: i.mode,
            tier: i.tier,
            content: i.content,
            tags: i.tags,
            embedding_status: i.embedding_status,
            valid_until: i.valid_until,
            created_at: i.created_at,
          })),
        };
      }
      case 'memory_get': {
        const item = await get(CanonicalMemoryService).get(String(args.id));
        return item ?? { error: { kind: 'not_found', id: args.id } };
      }
      case 'memory_delete': {
        const ok = await get(CanonicalMemoryService).delete(
          String(args.id),
          (args.mode as 'soft' | 'hard') ?? 'soft',
          { user_id: userId },
        );
        return { deleted: ok, id: args.id };
      }
      case 'memory_supersede': {
        const provenance: Provenance = {
          agent_id: null,
          session_id: null,
          collab_id: null,
          model: null,
          provider: null,
          tool_chain: ['memory_supersede'],
          created_by: 'agent',
          source_backend: 'almyty-native',
        };
        try {
          const result = await get(CanonicalMemoryService).supersede(
            String(args.old_id),
            {
              mode: 'memory',
              scope: { scope_type: 'workspace', scope_id: orgId },
              content: String(args.content),
              tier: (args.tier as Tier) ?? 'long',
              tags: args.tags,
              provenance,
            },
            { user_id: userId },
          );
          return {
            old_id: result.old.id,
            new_id: result.new.id,
            valid_until: result.old.valid_until,
          };
        } catch (err) {
          if (err instanceof MemoryError) return { error: err.tag };
          throw err;
        }
      }

      case 'memory_consolidate':
        return get(ConsolidationService).run(
          {
            scope_type: (args.scope_type as ScopeType) || 'workspace',
            scope_id: args.scope_id || orgId,
          },
          { force: !!args.force },
        );
      case 'memory_transfer':
        return get(MemoryRouter).transfer(
          {
            scope_type: (args.scope_type as ScopeType) || 'workspace',
            scope_id: args.scope_id || orgId,
          },
          String(args.source),
          String(args.target),
          { mode: args.mode as Mode, dry_run: !!args.dry_run },
        );
      case 'memory_sync':
        return get(MemorySyncService).sync({
          scope_type: (args.scope_type as ScopeType) || 'workspace',
          scope_id: args.scope_id || orgId,
        });
      case 'memory_list_backends':
        return get(MemoryRouter).list_backends();
      case 'memory_backends_health':
        return get(MemoryRouter).healthAll();

      default: throw new Error(`Unknown tool: ${name}`);
    }
  }
}
