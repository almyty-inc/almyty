/**
 * AlmytyMcpService — serves almyty platform management as native MCP tools.
 * Pure code. No DB entries. Tool definitions are inline. Execution calls
 * existing NestJS services via ModuleRef. Mounted at POST /:org/almyty.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { JsonRpcErrorCode, JsonRpcResponse } from './types/mcp.types';
import {
  DEFAULT_CALL_CONTEXT,
  McpCallContext,
  McpPolymorphicResult,
  McpSurface,
  McpToolResult,
  declaresElicitation,
  declaresTasks,
  handleMessage,
  mcpError,
} from './core/mcp-protocol-core';
import { McpAgentRuns } from './services/mcp-agent-runs';
import { AgentRun } from '../../entities/agent-run.entity';
import { RetentionPolicy } from '../../entities/retention-policy.entity';
import { ApisService } from '../apis/apis.service';
import { ToolsService } from '../tools/tools.service';
import { GatewaysService } from '../gateways/gateways.service';
import { AgentStatus } from '../../entities/agent.entity';
import { GatewayKind } from '../../entities/gateway.entity';
import { agentIsInvokable, runsOnAutonomousRuntime } from '../agents/agent-invocation';
import { AgentsService } from '../agents/agents.service';
import { AgentExecutionEngine } from '../agents/agent-execution.engine';
import { AgentRuntimeService } from '../agents/agent-runtime.service';
import { AgentChannelsService } from '../agent-channels/agent-channels.service';
import { AppBuildsService } from '../agent-channels/app-builds.service';
import { ChannelType } from '../../entities/agent-channel.entity';

/** The channel types an MCP caller may name. */
const CHANNEL_TYPE_NAMES: string[] = Object.values(ChannelType);

/** What the channel tools say about a channel: never its configuration. */
function channelSummary(channel: { id: string; name?: string; type: string; status: string; slug: string | null; gatewayId: string | null; endpoint?: string }) {
  return { id: channel.id, name: channel.name, type: channel.type, status: channel.status, slug: channel.slug, gatewayId: channel.gatewayId, endpoint: channel.endpoint };
}
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
import { getRepositoryToken } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';
import { ModelCatalogService } from '../model-catalog/model-catalog.service';
import { ModelRouterService } from '../model-catalog/routing/model-router.service';
import { RoutingPolicy } from '../model-catalog/routing/model-router';
import { computeCoFailure, isReportable, MIN_COMPARABLE_REQUESTS } from '../model-catalog/routing/co-failure';
import { attemptsFrom, failedAttemptsFrom } from '../model-catalog/routing/attempt-records';
import { ModelDeploymentsService } from '../model-deployments/model-deployments.service';
import { ModelVersionsService } from '../model-registry/model-versions.service';
import { AgentExecution } from '../../entities/agent-execution.entity';
import { ConnectionsService } from '../connections/connections.service';
import { GrantsService } from '../connections/grants/grants.service';
import { CredentialsService } from '../credentials/credentials.service';
import { UsersService } from '../users/users.service';
import { RunnerService } from '../runner/runner.service';
import { WorkspaceService } from '../workspace/workspace.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { BudgetsService } from '../budgets/budgets.service';
import { SpendService } from '../budgets/spend.service';
import { startOfPeriod } from '../budgets/spend-period.util';
import { AnalyticsService } from '../monitoring/analytics.service';
import { MonitoringService } from '../monitoring/monitoring.service';
import { ToolHubService } from '../tool-hub/tool-hub.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { userPrincipal } from '../../common/authorization/execution-access.service';

interface AssignmentSummary {
  toolsAssigned: number;
  toolsSkipped: Array<{ toolId: string; reason: string }>;
  hint?: string;
}

/**
 * Turn a GatewayToolService.bulkAssociateTools result into the honest
 * shape an MCP caller needs.
 *
 * bulkAssociateTools only attaches tools whose status is ACTIVE
 * (gateways/gateway-tool-queries.helper.ts:175) and reports the rest in
 * `skipped`. Reporting the number of ids *requested* told an agent "12
 * tools assigned" about a gateway serving 0. The UI cannot assign a DRAFT
 * tool either -- getAvailableTools filters to ACTIVE and the single-assign
 * path refuses a non-active tool outright -- so the honest behaviour here
 * is to name what was skipped, not to quietly activate tools the operator
 * has not published.
 */
function summarizeAssignment(result: any): AssignmentSummary {
  const toolsSkipped: Array<{ toolId: string; reason: string }> = Array.isArray(result?.skipped)
    ? result.skipped
    : [];
  const notActive = toolsSkipped.filter((s) => /not active/i.test(s.reason));
  return {
    toolsAssigned: Array.isArray(result?.associated) ? result.associated.length : 0,
    toolsSkipped,
    ...(notActive.length
      ? {
          hint: `${notActive.length} tool(s) were skipped because they are not ACTIVE (generated tools start as DRAFT). Call activate_tool with those ids, then assign again.`,
        }
      : {}),
  };
}

const TOOLS = [
  { name: 'list_apis', description: 'List all connected APIs', inputSchema: { type: 'object', properties: {} } },
  { name: 'create_api', description: 'Connect a new API. `baseUrl` is required: every generated tool builds its request URL from it, so an API without one produces tools that are blocked at run time. Pass `authentication` to set auth (e.g. {type:"api_key",config:{parameter:"X-Key",location:"header",apiKey:"..."}}).', inputSchema: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string', enum: ['openapi', 'graphql', 'soap', 'protobuf', 'sdk'] }, baseUrl: { type: 'string', description: 'http:// or https:// root the generated tools call. Required.' }, description: { type: 'string' }, version: { type: 'string' }, headers: { type: 'object', description: 'Default headers sent on every call.', additionalProperties: true }, authentication: { type: 'object', description: 'API auth: {type, config}', additionalProperties: true }, rateLimits: { type: 'object', description: '{requestsPerSecond, requestsPerMinute, requestsPerHour}', additionalProperties: true } }, required: ['name', 'type', 'baseUrl'] } },
  { name: 'update_api', description: 'Update an existing API. Use to change baseUrl, headers, authentication, or rateLimits without deleting.', inputSchema: { type: 'object', properties: { apiId: { type: 'string' }, name: { type: 'string' }, baseUrl: { type: 'string' }, headers: { type: 'object', additionalProperties: true }, authentication: { type: 'object', description: 'API auth: {type, config}', additionalProperties: true }, rateLimits: { type: 'object', additionalProperties: true } }, required: ['apiId'] } },
  { name: 'import_schema', description: 'Import schema + generate tools (async — returns a jobId). Pass either schemaUrl OR schemaContent.', inputSchema: { type: 'object', properties: { apiId: { type: 'string' }, schemaUrl: { type: 'string' }, schemaContent: { type: 'string', description: 'Inline schema content (use instead of schemaUrl)' }, generateTools: { type: 'boolean' } }, required: ['apiId'] } },
  { name: 'check_import_status', description: 'Check the status of a schema import job', inputSchema: { type: 'object', properties: { jobId: { type: 'string', description: 'Job ID returned by import_schema' } }, required: ['jobId'] } },
  { name: 'delete_api', description: 'Delete an API by ID', inputSchema: { type: 'object', properties: { apiId: { type: 'string', description: 'API ID to delete' } }, required: ['apiId'] } },
  { name: 'list_tools', description: 'List all tools', inputSchema: { type: 'object', properties: {} } },
  { name: 'delete_tool', description: 'Delete a tool by ID', inputSchema: { type: 'object', properties: { toolId: { type: 'string', description: 'Tool ID to delete' } }, required: ['toolId'] } },
  { name: 'activate_tool', description: 'Activate tools so gateways can serve them. Generated tools (from import_schema) land in DRAFT and a gateway only attaches ACTIVE ones — this is the step between import_schema and create_gateway. Accepts one toolId or many toolIds; each id is reported separately, so one failure does not lose the rest.', inputSchema: { type: 'object', properties: { toolId: { type: 'string', description: 'Single tool ID.' }, toolIds: { type: 'array', items: { type: 'string' }, description: 'Several tool IDs. Takes precedence over toolId.' } } } },
  { name: 'list_gateways', description: 'List the gateways: MCP, UTCP and Skills gateways serving tools. An agent\'s channels (web chat, widget, messaging platforms, A2A) are not gateways; list them with list_channels.', inputSchema: { type: 'object', properties: {} } },
  { name: 'delete_gateway', description: 'Delete a gateway by ID', inputSchema: { type: 'object', properties: { gatewayId: { type: 'string', description: 'Gateway ID to delete' } }, required: ['gatewayId'] } },
  { name: 'create_gateway', description: 'Create a gateway. Each gateway serves one protocol. A gateway is an MCP server, a UTCP manual or an Agent Skills bundle (mcp, utcp, skills); tools are auto-assigned. A web chat, website widget, messaging channel or A2A endpoint is a channel on an agent (add_channel) and is refused here. Only ACTIVE tools can be attached — freshly generated tools are DRAFT, so run activate_tool first or read `toolsSkipped` in the result to see exactly what was left off.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string', enum: ['mcp', 'utcp', 'skills'] }, endpoint: { type: 'string', description: 'URL slug. Auto-generated from name if omitted.' }, toolIds: { type: 'array', items: { type: 'string' }, description: 'Specific tool IDs to assign (tool-kind only)' }, apiIds: { type: 'array', items: { type: 'string' }, description: 'Assign all tools from these API IDs (tool-kind only)' }, assignTools: { type: 'boolean', description: 'Auto-assign all org tools if no toolIds/apiIds given. Default: true for tool-kind.' }, configuration: { type: 'object', description: 'Gateway-type-specific config. MCP: {transport: http} (every gateway answers over Streamable HTTP; sse, the legacy HTTP+SSE transport, is deprecated in MCP 2026-07-28 and only accepted for older configurations). UTCP: {protocol: http|tcp}. Defaults are sensible per type.', additionalProperties: true } }, required: ['name', 'type'] } },
  { name: 'assign_tools_to_gateway', description: 'Assign tools to a gateway by tool IDs or by API name (assigns all tools from that API). Only ACTIVE tools attach; DRAFT ones come back in `toolsSkipped` with a reason — activate_tool them and call again. `toolsAssigned` is the number that actually attached, not the number requested.', inputSchema: { type: 'object', properties: { gatewayId: { type: 'string' }, toolIds: { type: 'array', items: { type: 'string' }, description: 'Tool IDs to assign' }, apiName: { type: 'string', description: 'Assign all tools from this API (by name)' } }, required: ['gatewayId'] } },
  { name: 'add_auth_to_gateway', description: 'Add an auth method to a gateway. Per-type `configuration`: api_key needs {keyHeader} and/or {keyQuery} (defaults to x-api-key / api_key when omitted); jwt REQUIRES {secret} — a gateway-specific one, not the platform JWT secret; bearer_token, basic_auth, oauth2 and none need no configuration (they validate against org API keys, user credentials and issued OAuth tokens respectively).', inputSchema: { type: 'object', properties: { gatewayId: { type: 'string' }, type: { type: 'string', enum: ['api_key', 'bearer_token', 'basic_auth', 'oauth2', 'jwt', 'none'], description: 'Auth type to add' }, configuration: { type: 'object', description: 'Type-specific config. Required for jwt ({secret}); optional for api_key ({keyHeader, keyQuery}); ignored by the rest.', additionalProperties: true } }, required: ['gatewayId', 'type'] } },
  { name: 'remove_auth_from_gateway', description: 'Remove an auth method from a gateway', inputSchema: { type: 'object', properties: { gatewayId: { type: 'string' }, authId: { type: 'string', description: 'Auth config ID to remove' } }, required: ['gatewayId', 'authId'] } },
  { name: 'list_agents', description: 'List all agents', inputSchema: { type: 'object', properties: {} } },
  // Mirrors CreateAgentDto (agents/dto/create-agent.dto.ts). `status` is
  // deliberately not exposed: activate_agent is the only path that runs
  // pipeline validation first, so setting status here would mint an
  // "active" agent with a graph that cannot execute.
  {
    name: 'create_agent',
    description: 'Create an agent. Created agents are DRAFT — call activate_agent before invoke_agent. workflow mode executes `pipeline`; autonomous mode runs a ReAct loop from `instructions` + `toolIds`.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        mode: { type: 'string', enum: ['workflow', 'autonomous'], description: 'Default: workflow.' },
        instructions: { type: 'string', description: 'System prompt / operating instructions. This is what an autonomous agent runs on.' },
        personality: { type: 'string' },
        pipeline: {
          type: 'object',
          description: 'Workflow mode: the DAG that gets executed. Validated on activate_agent — a workflow agent needs at least one input and one output node. Node types: input, output, llm_call, tool_call, condition, transform, loop, parallel, merge, sub_agent.',
          properties: {
            nodes: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, type: { type: 'string', enum: ['input', 'output', 'llm_call', 'tool_call', 'condition', 'transform', 'loop', 'parallel', 'merge', 'sub_agent'] }, label: { type: 'string' }, config: { type: 'object', additionalProperties: true }, position: { type: 'object', additionalProperties: true } }, required: ['id', 'type', 'config'] } },
            edges: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, source: { type: 'string' }, target: { type: 'string' }, label: { type: 'string' }, condition: { type: 'string' } }, required: ['id', 'source', 'target'] } },
          },
          additionalProperties: true,
        },
        toolIds: { type: 'array', items: { type: 'string' }, description: 'Tools this agent may call. Use list_tools for ids; a DRAFT tool needs activate_tool first.' },
        modelConfig: { type: 'object', description: '{providerId, model, temperature, maxTokens}. Leave model blank to take the provider\'s live default.', additionalProperties: true },
        memoryConfig: { type: 'object', description: '{enabled, account ("almyty-native" or an outside backend id), whose (person|agent|shared), save (facts|conversations|asked), neverSave (rules, one per line), retentionDays (null keeps until deleted), credentialId (a connection of the agent itself for that service)}', additionalProperties: true },
        agentConfig: { type: 'object', description: '{callableAgentIds (agents it may call), apiIds (APIs whose tools it may use, including later ones), runnerLabels (labels its runner must have), runnerId (the one runner it runs on), canCreateAgents, maxTemporaryAgents (per run), maxTemporaryAgentsAlive (at once)}', additionalProperties: true },
        collaboration: { type: 'object', description: '{strategy: sequential|parallel|race|debate, participants: [{kind: "agent", agentId, role?} | {kind: "model", providerId?, model?, routing?, role?, instructions?, temperature?, maxTokens?}] (a model participant needs providerId or routing), sharedBrief?, rules?: {maxTotalCost?, maxChainDepth?, outputFormat?: text|json, escalation?, conflictResolution?}, judge?: <participant>, maxRounds?}', additionalProperties: true },
        models: { type: 'object', description: 'Autonomous mode: the roles and how they work together. {strategy: single|cascade|best_of_n|panel|explore_extract_patch, roles: [{key, name, purpose: main|drafter|checker|panelist|judge|explorer|summariser|teammate, kind: "model", providerId?, model?, routing?, temperature?, maxTokens?, instructions?} | {key, name, purpose: panelist|teammate, kind: "agent", agentId}], candidates?: 2-5 (best_of_n)}. Exactly one main role. Slots each strategy needs: cascade drafter+checker+main; best_of_n main+checker; panel main+2 panelists (an optional judge writes the agreed answer; without one the main role judges); explore_extract_patch explorer+summariser+main+checker. The main role is mirrored into modelConfig.', additionalProperties: true },
        variables: { type: 'object', description: 'Default variable values available to the pipeline.', additionalProperties: true },
        settings: { type: 'object', additionalProperties: true },
        webhookUrl: { type: 'string' },
        visibility: { type: 'string', enum: ['org', 'team'] },
        teamId: { type: 'string' },
      },
      required: ['name'],
    },
  },
  { name: 'update_agent', description: 'Update an agent in place. Same fields as create_agent; only the fields you pass change.', inputSchema: { type: 'object', properties: { agentId: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, mode: { type: 'string', enum: ['workflow', 'autonomous'] }, instructions: { type: 'string' }, personality: { type: 'string' }, pipeline: { type: 'object', description: 'Replaces the DAG. Validated for workflow mode; the previous graph is auto-snapshotted as a version.', additionalProperties: true }, toolIds: { type: 'array', items: { type: 'string' } }, modelConfig: { type: 'object', additionalProperties: true }, memoryConfig: { type: 'object', additionalProperties: true }, agentConfig: { type: 'object', additionalProperties: true }, collaboration: { type: 'object', additionalProperties: true }, models: { type: 'object', additionalProperties: true }, variables: { type: 'object', additionalProperties: true }, settings: { type: 'object', additionalProperties: true }, webhookUrl: { type: 'string' }, version: { type: 'string' }, visibility: { type: 'string', enum: ['org', 'team'] }, teamId: { type: 'string' } }, required: ['agentId'] } },
  { name: 'delete_agent', description: 'Delete an agent by ID', inputSchema: { type: 'object', properties: { agentId: { type: 'string' } }, required: ['agentId'] } },
  { name: 'activate_agent', description: 'Activate an agent so it can be invoked. Workflow agents are pipeline-validated first and the call is refused if the graph is incomplete. An agent must be active before invoke_agent will run it.', inputSchema: { type: 'object', properties: { agentId: { type: 'string' } }, required: ['agentId'] } },
  { name: 'deactivate_agent', description: 'Deactivate an agent (status -> inactive). Keeps the agent and its graph; it just stops answering.', inputSchema: { type: 'object', properties: { agentId: { type: 'string' } }, required: ['agentId'] } },
  { name: 'invoke_agent', description: 'Run an agent and return the result. Workflow agents execute their pipeline synchronously and return the execution id plus output; autonomous agents start a run and return the run id. Requires an ACTIVE agent — call activate_agent first.', inputSchema: { type: 'object', properties: { agentId: { type: 'string' }, input: { type: 'object', description: 'Run input. Workflow agents read it in their input node; autonomous agents typically take {message: "..."}.', additionalProperties: true }, variables: { type: 'object', description: 'Workflow mode: overrides the agent\'s default variables for this run.', additionalProperties: true }, metadata: { type: 'object', description: 'Stamped onto the execution record.', additionalProperties: true } }, required: ['agentId'] } },
  { name: 'get_run', description: 'Where an autonomous agent run stands: its status, its output once finished, and what it waits for (a question for you, or an approval). invoke_agent returns the run id; follow it with this.', inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] } },
  { name: 'answer_run', description: 'Answer the question an autonomous agent run asked (get_run shows it as waitingFor.question). The run continues with the answer.', inputSchema: { type: 'object', properties: { runId: { type: 'string' }, answer: { type: 'string', description: 'Your answer, in plain words.' } }, required: ['runId', 'answer'] } },
  { name: 'list_providers', description: 'List providers', inputSchema: { type: 'object', properties: {} } },
  { name: 'add_provider', description: 'Add a provider', inputSchema: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string' }, apiKey: { type: 'string' } }, required: ['name', 'type', 'apiKey'] } },
  // -- Channels on an agent: where people (or other agents) reach it --
  { name: 'list_channels', description: "List an agent's channels: web chat, website widget, messaging platforms, A2A, desktop and terminal apps", inputSchema: { type: 'object', properties: { agentId: { type: 'string' } }, required: ['agentId'] } },
  { name: 'add_channel', description: 'Add a channel to an agent. web = web chat on its own link, widget = chat bubble for a website, a2a = other agents, tui/desktop = downloadable apps, the rest are messaging platforms whose keys come from a credential on Credentials, picked with `credentialId`. Keys sent in `configuration` are refused.', inputSchema: { type: 'object', properties: { agentId: { type: 'string' }, type: { type: 'string', enum: CHANNEL_TYPE_NAMES }, name: { type: 'string', description: 'What to call it, unique among the agent\'s channels. The type\'s label when left out.' }, slug: { type: 'string', description: 'Web chat address or download name. Made from the agent name when left out.' }, configuration: { type: 'object', description: 'Platform settings that are not keys, e.g. a desktop app {bundleId}.', additionalProperties: true }, credentialId: { type: 'string', description: 'The credential holding the platform keys.' } }, required: ['agentId', 'type'] } },
  { name: 'get_channel', description: 'Get one channel of an agent, with what its branding and visitor rules resolve to', inputSchema: { type: 'object', properties: { agentId: { type: 'string' }, channelId: { type: 'string' } }, required: ['agentId', 'channelId'] } },
  { name: 'check_channel', description: 'What is stopping this channel from going live or being built (missing keys, cost cap, rate limits, sign-in). Read this before publishing.', inputSchema: { type: 'object', properties: { agentId: { type: 'string' }, channelId: { type: 'string' } }, required: ['agentId', 'channelId'] } },
  { name: 'update_channel', description: "Change a channel: its name, a web chat's address (slug), its platform settings (configuration.aiDisclosure: false turns the AI disclosure off, white-label only), the credential holding its keys, and its own overrides of the agent's branding and visitor rules (null inherits).", inputSchema: { type: 'object', properties: { agentId: { type: 'string' }, channelId: { type: 'string' }, name: { type: 'string' }, slug: { type: 'string', description: 'Web chat only: its address, free across every organization' }, configuration: { type: 'object', additionalProperties: true }, credentialId: { type: ['string', 'null'] }, branding: { type: ['object', 'null'], additionalProperties: true }, visitorRules: { type: ['object', 'null'], additionalProperties: true } }, required: ['agentId', 'channelId'] } },
  { name: 'delete_channel', description: 'Delete a channel (and the gateway it answered on)', inputSchema: { type: 'object', properties: { agentId: { type: 'string' }, channelId: { type: 'string' } }, required: ['agentId', 'channelId'] } },
  { name: 'publish_channel', description: 'Publish a channel so it answers. Stands up the matching gateway. Refuses when platform keys are missing, when an open channel has no cost cap or rate limits, or when the agent is a workflow.', inputSchema: { type: 'object', properties: { agentId: { type: 'string' }, channelId: { type: 'string' } }, required: ['agentId', 'channelId'] } },
  { name: 'unpublish_channel', description: 'Stop a channel answering, keeping its settings and keys (the gateway is deactivated, not deleted).', inputSchema: { type: 'object', properties: { agentId: { type: 'string' }, channelId: { type: 'string' } }, required: ['agentId', 'channelId'] } },
  { name: 'get_public_settings', description: "An agent's branding and visitor rules, which every channel inherits", inputSchema: { type: 'object', properties: { agentId: { type: 'string' } }, required: ['agentId'] } },
  { name: 'update_public_settings', description: "Change an agent's branding (appName, primaryColor, logoUrl, greeting, theme, suggestedPrompts, aiDisclosure, whiteLabel) and visitor rules ({authMode, limits: {costCapCents, perUserRateLimit, perIpRateLimit, dailySpendCapCents, monthlySpendCapCents}, privacy: {retentionDays, visitorCanDelete, visitorCanExport, visitorMemory}}). Cents, not currency.", inputSchema: { type: 'object', properties: { agentId: { type: 'string' }, branding: { type: ['object', 'null'], additionalProperties: true }, visitorRules: { type: ['object', 'null'], additionalProperties: true } }, required: ['agentId'] } },
  { name: 'build_channel', description: 'Queue a downloadable build of a desktop or terminal app channel for one platform. Poll list_builds for status.', inputSchema: { type: 'object', properties: { agentId: { type: 'string' }, channelId: { type: 'string' }, platform: { type: 'string', description: 'e.g. linux-x64, macos-arm64, windows-x64' }, version: { type: 'string' }, macPackaging: { type: 'string', description: 'macOS desktop only: zip or dmg' } }, required: ['agentId', 'channelId', 'platform'] } },
  { name: 'list_builds', description: 'Build history of a desktop or terminal app channel', inputSchema: { type: 'object', properties: { agentId: { type: 'string' }, channelId: { type: 'string' } }, required: ['agentId', 'channelId'] } },
  // ── Memory (canonical schema v1) ──────────────────────────────
  { name: 'memory_put', description: 'Write a memory or document item. memory mode = agent-written facts/preferences; document mode = chunked imported text.', inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['memory', 'document'] }, scope_type: { type: 'string', enum: ['user', 'workspace', 'project', 'collab'], description: 'Defaults to workspace if omitted.' }, content: { type: 'string' }, tier: { type: 'string', enum: ['short', 'project', 'long', 'shared'], description: 'Memory mode only. Defaults to short.' }, tags: { type: 'array', items: { type: 'string' } }, ttl_seconds: { type: 'number' }, source_uri: { type: 'string', description: 'Document mode: where the text came from.' }, source_version: { type: 'number' } }, required: ['mode', 'content'] } },
  { name: 'memory_search', description: 'Hybrid (vector + FTS) search across a scope.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, scope_type: { type: 'string', enum: ['user', 'workspace', 'project', 'collab'] }, mode: { type: 'string', enum: ['memory', 'document'] }, tier: { type: 'string', enum: ['short', 'project', 'long', 'shared'] }, top_k: { type: 'number' }, fts_only: { type: 'boolean' } }, required: ['query'] } },
  { name: 'memory_list', description: 'List memory items in a scope (newest first).', inputSchema: { type: 'object', properties: { scope_type: { type: 'string', enum: ['user', 'workspace', 'project', 'collab'] }, mode: { type: 'string', enum: ['memory', 'document'] }, tier: { type: 'string', enum: ['short', 'project', 'long', 'shared'] }, tags: { type: 'array', items: { type: 'string' } }, include_superseded: { type: 'boolean' }, include_deleted: { type: 'boolean' }, limit: { type: 'number' }, cursor: { type: 'string' } } } },
  { name: 'memory_get', description: 'Get a single memory item by id.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'memory_delete', description: 'Delete a memory item. mode=soft (default) sets deleted_at; mode=hard removes the row.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, mode: { type: 'string', enum: ['soft', 'hard'] } }, required: ['id'] } },
  { name: 'memory_supersede', description: 'Bi-temporal supersession (memory mode only): close valid_until on the old row and write a new one with the same logical content. The new row inherits the old row\'s scope; pass scope_type only to assert what you expect (a mismatch is refused, not silently moved).', inputSchema: { type: 'object', properties: { old_id: { type: 'string' }, content: { type: 'string' }, scope_type: { type: 'string', enum: ['user', 'workspace', 'project', 'collab'], description: 'Optional assertion. Must match the old row\'s scope or the call is refused.' }, tier: { type: 'string', enum: ['short', 'project', 'long', 'shared'] }, tags: { type: 'array', items: { type: 'string' } } }, required: ['old_id', 'content'] } },
  { name: 'memory_consolidate', description: 'Run consolidation now: a model extracts durable facts from short-scope rows and supersedes them. Returns the run report.', inputSchema: { type: 'object', properties: { scope_type: { type: 'string', enum: ['user', 'workspace', 'project', 'collab'] }, force: { type: 'boolean', description: 'Bypass enabled-flag and min_short_count thresholds.' } } } },
  { name: 'memory_transfer', description: 'Move memory items from one backend to another for a scope. Returns a TransferReport with capability-degradation warnings.', inputSchema: { type: 'object', properties: { scope_type: { type: 'string', enum: ['user', 'workspace', 'project', 'collab'] }, source: { type: 'string', description: 'Source backend id (almyty-native, mem0, zep, supermemory, vertex-memory-bank, anthropic-memory-tool)' }, target: { type: 'string' }, mode: { type: 'string', enum: ['memory', 'document'] }, dry_run: { type: 'boolean' } }, required: ['source', 'target'] } },
  { name: 'memory_sync', description: 'Reconcile primary↔mirror for a scope. Last-write-wins by updated_at. Returns counts moved each direction.', inputSchema: { type: 'object', properties: { scope_type: { type: 'string', enum: ['user', 'workspace', 'project', 'collab'] } } } },
  { name: 'memory_list_backends', description: 'List configured memory backends + capabilities + supported modes.', inputSchema: { type: 'object', properties: {} } },
  { name: 'memory_backends_health', description: 'Run a health check against every backend.', inputSchema: { type: 'object', properties: {} } },
  // ── Models: catalog, selectability, routing, deployments, registry ──
  { name: 'list_models', description: 'List the organization\'s model cards. `selectable` is the only field that says a model can actually be used right now: it needs an active card, a callable provider and one passed validation run. Support is registry data, never a hardcoded list — a model absent here is simply not registered. Filter by status, privacyTier, providerId, or selectable:true for just the usable ones.', inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['active', 'inactive', 'error', 'deploying'] }, privacyTier: { type: 'string', enum: ['local', 'private_cloud', 'public'] }, providerId: { type: 'string', description: 'Stored LLM provider id.' }, selectable: { type: 'boolean', description: 'Only cards that are usable right now.' } } } },
  { name: 'sync_models', description: 'Import what a provider currently lists as model cards. Pass providerId for one provider, omit it to sync every active provider of the org; vendor ids that vanished go inactive. Imported cards are UNVALIDATED and therefore not selectable — run validate_model on the one you want before an agent can use it.', inputSchema: { type: 'object', properties: { providerId: { type: 'string', description: 'One stored LLM provider. Omit to sync every active provider.' } } } },
  { name: 'validate_model', description: 'Make one real, short chat call through a model card and record the outcome. This is the only thing that flips a card to validated, so it is the gate to `selectable`. It spends a few tokens and can fail with the provider\'s own error, which is then recorded on the card.', inputSchema: { type: 'object', properties: { modelId: { type: 'string', description: 'Model card id from list_models.' } }, required: ['modelId'] } },
  { name: 'preview_model_routing', description: 'Ask what a routing policy would choose right now, in order, and why every other card was rejected. This plans only: no provider is called and nothing is charged. It is the honest answer to "why did it not pick that model".', inputSchema: { type: 'object', properties: { objective: { type: 'string', enum: ['cheapest', 'fastest', 'pinned'] }, privacyTier: { type: 'string', enum: ['local', 'private_cloud', 'public'], description: 'Most public tier the request may use.' }, regions: { type: 'array', items: { type: 'string' } }, capabilities: { type: 'object', additionalProperties: { type: 'boolean' }, description: 'Capabilities the request needs, e.g. {tools:true,vision:true}.' }, fallbackChain: { type: 'array', items: { type: 'string' }, description: 'Explicit order of card ids or vendor model ids; wins over the objective.' }, pinnedModel: { type: 'string', description: 'For objective "pinned".' }, budgetHeadroomCents: { type: 'number' }, connectionPreference: { type: 'array', items: { type: 'string' }, description: 'Provider ids or provider types to prefer, best first.' } } } },
  { name: 'list_model_deployments', description: 'List self-hosted model deployments: desired vs actual state, replicas, endpoint state and cost so far. Secrets in providerConfig come back masked. Read-only — creating, scaling and tearing a deployment down is not exposed here.', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_model_versions', description: 'List registered model weights: one pinned registry URI per version (hf://, s3://, gs://, file://) with its base architecture, quantizations and manifest sha. Read-only.', inputSchema: { type: 'object', properties: {} } },
  // ── Connections + credentials: the one store for third-party secrets ──
  { name: 'list_connectors', description: 'The connector catalog: built-in, provider-derived and this organization\'s custom connectors, each with the connect methods it offers and the field names each method wants. Catalog data, never secrets. Read this before start_connection to learn the connectorKey and which method to use.', inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['inference', 'deployment', 'memory', 'mcp', 'tool_source', 'channel', 'cloud', 'registry'] } } } },
  { name: 'list_connections', description: 'List the organization\'s connections. A connection is a stored third-party account; rows come back masked — connector, account label, health, granted scopes and expiry, never a secret value.', inputSchema: { type: 'object', properties: {} } },
  { name: 'start_connection', description: 'Start connecting a third-party account. For a redirect method (oauth2_pkce, oauth2_code, installation) this returns an authorize URL and a state: open the URL, then finish with complete_connection. For any other method (api_key, service_account, cloud_iam, oauth2_client_credentials) it refuses and names the fields it wanted — a raw secret must not travel through this tool, so use the /credentials page or `npx @almyty/credentials add`. There is deliberately no secret parameter here.', inputSchema: { type: 'object', properties: { connectorKey: { type: 'string', description: 'From list_connectors.' }, method: { type: 'string', enum: ['oauth2_pkce', 'oauth2_code', 'oauth2_client_credentials', 'api_key', 'cloud_iam', 'service_account', 'installation'], description: 'Defaults to the connector\'s first method.' }, owner: { type: 'string', enum: ['org', 'user'], description: 'org (default), or scoped to the calling user.' }, mode: { type: 'string', enum: ['browser', 'headless'], description: 'headless asks the provider to print a code you paste back through complete_connection.' }, name: { type: 'string', description: 'Label for the connection.' } }, required: ['connectorKey'] } },
  { name: 'complete_connection', description: 'Finish a headless redirect connect: hand back the state from start_connection plus the one-time authorization code the provider printed. The code is exchanged and the resulting tokens are stored encrypted in the credentials vault; nothing is echoed back.', inputSchema: { type: 'object', properties: { state: { type: 'string', description: 'The state returned by start_connection.' }, code: { type: 'string', description: 'The one-time authorization code the provider displayed.' } }, required: ['state', 'code'] } },
  { name: 'list_connection_grants', description: 'The grants on one connection: which user, team, role, agent or workspace may use or manage it, with any budget and expiry. Anything but the connection\'s owner reaches a connection only through a grant.', inputSchema: { type: 'object', properties: { connectionId: { type: 'string' } }, required: ['connectionId'] } },
  { name: 'grant_connection', description: 'Let a user, team, role, agent or workspace use (or manage) a connection. This is what makes a stored account reachable from an agent run: without a grant the resolve is refused at run time. principalId is a uuid, except for principalType "role" where it is the role name (owner, admin, member, viewer).', inputSchema: { type: 'object', properties: { connectionId: { type: 'string' }, principalType: { type: 'string', enum: ['user', 'team', 'role', 'agent', 'workspace'] }, principalId: { type: 'string', description: 'uuid, or the role name when principalType is "role".' }, permission: { type: 'string', enum: ['use', 'manage'], description: 'use (default) resolves the secret for a run; manage also edits grants.' }, budgetId: { type: 'string', description: 'Optional spend ceiling for this grant.' }, expiresAt: { type: 'string', description: 'ISO-8601 instant.' } }, required: ['connectionId', 'principalType', 'principalId'] } },
  { name: 'list_credentials', description: 'The secrets vault as the /credentials page shows it: stored credentials plus LLM provider keys not yet linked to one, with what each is used by. Every value is masked — this tool can neither read nor write a secret.', inputSchema: { type: 'object', properties: {} } },
  // ── Runners + workspaces: execution on a machine you own ──
  { name: 'list_runners', description: 'Your registered runners and the workspaces opened on them. A runner is a daemon on some machine (laptop, VM, CI box) that accepts dispatched work; only one in an online or busy state accepts anything, so check `state` and `lastHeartbeatAt` before assuming work will land. Read-only: a runner registers itself, and dispatching to one needs a live session this server cannot open for you.', inputSchema: { type: 'object', properties: {} } },
  // ── Organization ──
  { name: 'list_org_members', description: 'Members of the calling organization with their roles (owner, admin, member, viewer) and join dates — useful for picking a grant principal or an approver. Read-only: invites, role changes and removals are not exposed here.', inputSchema: { type: 'object', properties: {} } },
  // ── Cost governance ──
  { name: 'list_budgets', description: 'Spend budgets: the cents ceiling per period, optionally scoped to one agent or one provider, and whether a breach only warns (warn_log) or rejects the run (reject). An organization with no rows here has no cost ceiling at all.', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_spend', description: 'Actual spend for the current period: total cents, a timeseries and a per-agent breakdown. period=month (default) or day.', inputSchema: { type: 'object', properties: { period: { type: 'string', enum: ['day', 'month'] }, granularity: { type: 'string', enum: ['day', 'week', 'month'], description: 'Timeseries bucket. Default day.' } } } },
  // ── Analytics + monitoring (organization-scoped) ──
  { name: 'get_analytics', description: 'One organization-scoped report. overview: counts and recent activity. tools / gateways / models: usage per entity over a timeframe. agent_runs: run outcomes, duration and cost over the last 7 days. routing_failures: per agent, the share of requests where every model tried failed (a ceiling on what any routing change could win) — reported as a number only once there are enough comparable requests, else flagged not reportable. alerts: open monitoring alerts. Platform-wide metrics sit behind a platform-admin token and are not reachable from here.', inputSchema: { type: 'object', properties: { report: { type: 'string', enum: ['overview', 'tools', 'gateways', 'models', 'agent_runs', 'routing_failures', 'alerts'] }, timeframe: { type: 'string', description: 'tools / gateways / models only, e.g. 24h, 7d, 30d. Default 7d.' }, days: { type: 'number', description: 'routing_failures only: window in days, 1-90. Default 30.' } }, required: ['report'] } },
  // ── Tool hub ──
  { name: 'list_tool_templates', description: 'Search the tool-hub catalog: ready-made tool templates per provider and category that install as an API plus its generated tools. Returns public templates and this organization\'s own.', inputSchema: { type: 'object', properties: { category: { type: 'string' }, provider: { type: 'string' }, search: { type: 'string' }, page: { type: 'number' }, limit: { type: 'number', description: 'Default 20.' } } } },
  { name: 'install_tool_template', description: 'Install a tool-hub template: creates (or reuses) the API and generates its tools in one call — the short path when a template already exists for the provider, instead of create_api + import_schema. Pass credentialId to bind an already-stored credential so the generated tools can authenticate, or existingApiId to attach to an API you already have.', inputSchema: { type: 'object', properties: { templateId: { type: 'string' }, existingApiId: { type: 'string' }, credentialId: { type: 'string', description: 'A stored credential id from list_credentials — never a raw secret.' } }, required: ['templateId'] } },
  // ── Approvals ──
  { name: 'list_approvals', description: 'Pending approval requests visible to the caller. An agent run that hit an approval gate sits in waiting_approval until one of these is decided, so this is where a stalled run shows up.', inputSchema: { type: 'object', properties: {} } },
  { name: 'decide_approval', description: 'Approve or reject a pending approval. Approving resumes the waiting run; rejecting terminates it. Refused unless the caller may decide this one (team lead for a team-scoped request, or organization admin/owner).', inputSchema: { type: 'object', properties: { approvalId: { type: 'string' }, decision: { type: 'string', enum: ['approve', 'reject'] }, reason: { type: 'string', description: 'Recorded with the decision.' } }, required: ['approvalId', 'decision'] } },
];

/**
 * What each management tool does to the organization, for its MCP
 * annotations. Reads are listed by prefix; deletes are destructive;
 * everything else changes something.
 */
const READ_ONLY_PREFIXES = ['list_', 'get_', 'check_', 'preview_'];
const READ_ONLY_TOOLS = new Set(['memory_search', 'memory_get', 'memory_backends_health']);
const DESTRUCTIVE_TOOLS = new Set(['delete_api', 'delete_tool', 'delete_gateway', 'delete_agent', 'delete_channel', 'remove_auth_from_gateway', 'memory_delete']);
/** Tools that reach outside almyty: fetch a URL, call a model or a third party, run an agent. */
const OPEN_WORLD_TOOLS = new Set([
  'import_schema',
  'invoke_agent',
  'validate_model',
  'sync_models',
  'start_connection',
  'complete_connection',
  'install_tool_template',
  'memory_consolidate',
]);
const ACRONYMS: Record<string, string> = { api: 'API', apis: 'APIs', mcp: 'MCP', a2a: 'A2A' };

function managementTitle(name: string): string {
  const words = name.split('_').map((w) => ACRONYMS[w] ?? w);
  words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);
  return words.join(' ');
}

function managementAnnotations(name: string) {
  const readOnly = READ_ONLY_TOOLS.has(name) || READ_ONLY_PREFIXES.some((p) => name.startsWith(p));
  return {
    readOnlyHint: readOnly,
    ...(readOnly ? {} : { destructiveHint: DESTRUCTIVE_TOOLS.has(name) }),
    openWorldHint: OPEN_WORLD_TOOLS.has(name),
  };
}

/** The management tools as tools/list serves them: name, title, description, schema, annotations. */
const MANAGEMENT_TOOLS = TOOLS.map((tool) => ({
  name: tool.name,
  title: managementTitle(tool.name),
  description: tool.description,
  inputSchema: tool.inputSchema,
  annotations: managementAnnotations(tool.name),
}));

const MANAGEMENT_TOOL_NAMES: ReadonlySet<string> = new Set(TOOLS.map((tool) => tool.name));

@Injectable()
export class AlmytyMcpService {
  private readonly logger = new Logger(AlmytyMcpService.name);
  constructor(private readonly moduleRef: ModuleRef) {}

  /**
   * One POSTed MCP message on the management gateway (`/:org/almyty`).
   *
   * The protocol (notifications, batching, version negotiation, result
   * shaping) is the shared core's, the same one tenant gateways use
   * (core/mcp-protocol-core.ts); this service is only the management
   * surface: its tool list and what each tool does. It used to carry its
   * own dispatcher that answered every client in 2024-11-05.
   *
   * `null` means "nothing to send"; the caller turns that into an empty
   * 202 Accepted.
   */
  async handleJsonRpc(
    body: any,
    organizationId: string,
    userId: string,
    ctx: McpCallContext = DEFAULT_CALL_CONTEXT,
  ): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
    return handleMessage(body, this.surfaceFor(organizationId, userId), ctx);
  }

  private surfaceFor(organizationId: string, userId: string): McpSurface {
    return {
      serverInfo: () => ({ name: 'almyty', title: 'almyty platform', version: '1.0.0' }),
      capabilities: () => ({ tools: { listChanged: false } }),
      instructions: () =>
        'Manage this almyty organization: connect APIs, generate and activate tools, publish gateways, build and run agents.',
      listTools: async () => ({ tools: MANAGEMENT_TOOLS }),
      callTool: (params, ctx) => this.callTool(params?.name, params?.arguments || {}, organizationId, userId, ctx, params),
      // invoke_agent's autonomous runs, followed as tasks (Tasks extension).
      tasks: {
        get: (params, ctx) => this.agentRuns().getTask(params.taskId, organizationId, userId, ctx),
        update: (params) => this.agentRuns().updateTask(params.taskId, params.inputResponses as Record<string, unknown>, organizationId, userId),
        cancel: (params) => this.agentRuns().cancelTask(params.taskId, organizationId, userId),
      },
    };
  }

  /** Autonomous runs over MCP: tasks, input_required, get_run (mcp-agent-runs.ts). */
  private agentRuns(): McpAgentRuns {
    const runtime = this.moduleRef.get(AgentRuntimeService, { strict: false });
    const approvals = this.moduleRef.get(ApprovalsService, { strict: false });
    return new McpAgentRuns({
      runs: runtime.runRepository,
      runtime,
      approvals,
      runRetentionDays: async (organizationId) => {
        const policy = await runtime.runRepository.manager
          .getRepository(RetentionPolicy)
          .findOne({ where: { organizationId }, select: { id: true, agentRunsDays: true } });
        return policy?.agentRunsDays ?? null;
      },
    });
  }

  /**
   * A run the caller may read and answer through get_run and answer_run:
   * one in this organization whose agent they may run (the same gate
   * invoke_agent applies), else not found.
   */
  private async readableRun(runId: string, orgId: string, userId: string): Promise<AgentRun> {
    const runtime = this.moduleRef.get(AgentRuntimeService, { strict: false });
    const run = await runtime.getRun(runId, orgId);
    // A run of an agent the caller may not run reads like one that does not exist.
    await runtime.executionAccess
      .assertCanExecute(userPrincipal(userId, 'system_gateway'), run.agent, 'Agent')
      .catch(() => {
        throw new Error('Run not found');
      });
    return run;
  }

  /**
   * invoke_agent up to the point the run or execution exists. Same two
   * service methods the HTTP endpoint calls (agents/agent-execution.controller.ts
   * POST /:id/invoke), including the ACTIVE gate and the autonomous split:
   * routing an autonomous agent through the pipeline engine returns an
   * empty "completed" run with zero node results.
   */
  private async startInvocation(
    args: any,
    orgId: string,
    userId: string,
    runMetadata?: Record<string, unknown>,
  ): Promise<{ kind: 'autonomous'; run: AgentRun } | { kind: 'workflow'; payload: Record<string, unknown> }> {
    const get = <T>(cls: new (...a: any[]) => T): T => this.moduleRef.get(cls, { strict: false });
    const agent = await get(AgentsService).getAgent(String(args.agentId), orgId);
    // The org's own MCP endpoint acts as its caller: a team agent runs
    // only for its team (and org owners/admins), a private one only for
    // its owner -- refused as not found before its status is told.
    const principal = userPrincipal(userId, 'system_gateway');
    await get(AgentRuntimeService).executionAccess.assertCanExecute(principal, agent, 'Agent');
    if (!agentIsInvokable(agent)) {
      // The shared refusal already says to activate it; over MCP,
      // name the tool that does it rather than repeating the advice.
      throw new Error(
        `This agent is ${agent.status}, and only an active agent can be invoked. ` +
          'Call activate_agent first.',
      );
    }
    if (runsOnAutonomousRuntime(agent)) {
      const run = await get(AgentRuntimeService).startRun(agent.id, orgId, userId, args.input, {
        principal,
        ...(runMetadata ? { metadata: runMetadata } : {}),
      });
      return { kind: 'autonomous', run };
    }
    const execution: any = await get(AgentExecutionEngine).execute(
      agent,
      orgId,
      userId,
      { input: args.input, variables: args.variables, metadata: args.metadata, principal },
    );
    return {
      kind: 'workflow',
      payload: {
        mode: 'workflow',
        agentId: agent.id,
        executionId: execution.id,
        status: execution.status,
        success: execution.status === 'completed',
        output: execution.output ?? null,
        error: execution.error ?? null,
        nodeResults: execution.nodeResults ?? null,
        executionTimeMs: execution.executionTime ?? null,
        totalCost: execution.totalCost ?? null,
        totalTokens: execution.totalTokens ?? null,
      },
    };
  }

  /**
   * invoke_agent for a 2026-07-28 request. A client that declared the Tasks
   * extension gets the run as a task; one that declared elicitation gets the
   * run's result, or its question as `input_required`, within
   * MCP_INVOKE_WAIT_MS; its retry carries the answer (requestState). Anyone
   * else gets the run id, as legacy clients do.
   */
  private async invokeAgentModern(
    args: any,
    orgId: string,
    userId: string,
    ctx: McpCallContext,
    params: any,
  ): Promise<McpToolResult | McpPolymorphicResult> {
    const runs = this.agentRuns();
    if (params?.requestState !== undefined) {
      const { runId, result } = await runs.resumeFromRetry(params, orgId, userId, ctx, 'tools/call');
      if (result) return result;
      const run = await this.moduleRef.get(AgentRuntimeService, { strict: false }).getRun(runId, orgId);
      return asToolResult(autonomousSummary(run));
    }
    const asTask = declaresTasks(ctx) && !!userId;
    const started = await this.startInvocation(args, orgId, userId, asTask ? McpAgentRuns.taskMetadata(userId) : undefined);
    if (started.kind === 'workflow') return asToolResult(started.payload);
    if (asTask) return runs.createTaskResult(started.run);
    if (userId && declaresElicitation(ctx)) {
      const waited = await runs.waitForRun(started.run.id, orgId, userId, ctx, { method: 'tools/call', params });
      if (waited) return waited;
    }
    return asToolResult(autonomousSummary(started.run));
  }

  private async callTool(
    name: string,
    args: any,
    orgId: string,
    userId: string,
    ctx: McpCallContext = DEFAULT_CALL_CONTEXT,
    params?: any,
  ): Promise<McpToolResult | McpPolymorphicResult> {
    // An unknown tool is a protocol error (-32602), as on every other
    // surface; a known tool that fails is a tool error the model can read.
    if (!MANAGEMENT_TOOL_NAMES.has(name)) {
      throw mcpError(JsonRpcErrorCode.INVALID_PARAMS, `Tool not found: ${name}`);
    }
    try {
      if (name === 'invoke_agent' && ctx.era === 'modern') {
        return await this.invokeAgentModern(args, orgId, userId, ctx, params);
      }
      return asToolResult(await this.exec(name, args, orgId, userId));
    } catch (err: any) {
      // A protocol error (a refused requestState, bad inputResponses) is the
      // request's, not the tool's.
      if (isMcpProtocolError(err)) throw err;
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }

  private async exec(name: string, args: any, orgId: string, userId: string): Promise<any> {
    const get = <T>(cls: new (...a: any[]) => T): T => this.moduleRef.get(cls, { strict: false });
    switch (name) {
      case 'list_apis': {
        const { apis, total } = await get(ApisService).findAllByOrganization({ id: userId }, orgId, { limit: 50 });
        return { total, apis: apis.map(a => ({ id: a.id, name: a.name, type: a.type, status: a.status, baseUrl: a.baseUrl })) };
      }
      case 'create_api': {
        // Every generated tool builds its request URL from api.baseUrl
        // (tools/executors/tool-http.executor.ts:302). With no baseUrl,
        // validateUrl(undefined) fails and every call is returned as
        // BLOCKED at run time -- an API whose tools can never fire. The
        // HTTP path requires it (apis/dto/api.dto.ts:42); this one did not,
        // because it bypasses the DTO and calls the service directly.
        if (!args.baseUrl || !/^https?:\/\/.+/.test(String(args.baseUrl))) {
          throw new Error(
            'create_api requires baseUrl (a http:// or https:// URL). Generated tools build every request URL from it; without one every tool call against this API is blocked at run time.',
          );
        }
        // `userId` is the SECOND argument, not a field on the data object.
        // Passed inside the object it was silently ignored, so
        // assertCanScopeToTeam never ran and an MCP-created API could be
        // scoped to a team the caller does not belong to — the one
        // authorization check on this path, skipped by a comma.
        return get(ApisService).create({ ...args, organizationId: orgId }, userId);
      }
      case 'import_schema': {
        // Either schemaContent or schemaUrl must be supplied. Inline
        // content is the path callers want when they're crafting a
        // throwaway schema in-process; URL is the more common one.
        let content: string;
        if (args.schemaContent) {
          content = String(args.schemaContent);
        } else if (args.schemaUrl) {
          // Through ApisService, which is the HTTP twin of this feature and
          // now the only door onto this fetch.
          //
          // Two audits found this same bypass. It was a bare
          // `axios.get(args.schemaUrl, { timeout: 30000 })`: no SSRF gate,
          // no size cap, no redirect refusal, and the body came back to the
          // caller as the import's schemaContent. #696 fixed it by gating
          // and pinning here; this keeps that mechanism but moves it into
          // `fetchSchemaFromUrl`, which the REST route has always used and
          // which was NOT pinned -- so #696's version left the two doors
          // enforcing different rules, with the older one weaker.
          //
          // One helper, both callers, so a third entrance cannot be added
          // later with its own idea of what the gate is.
          content = await get(ApisService).fetchSchemaFromUrl(String(args.schemaUrl));
        } else {
          throw new Error('import_schema requires either schemaUrl or schemaContent');
        }
        const queue = this.moduleRef.get('BullQueue_schema-import', { strict: false });
        const job = await queue.add('import', {
          apiId: args.apiId,
          organizationId: orgId,
          schemaContent: content,
          options: { generateTools: args.generateTools !== false, createdBy: userId ?? null },
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
        const toolResult = await get(ToolsService).getTools({ organizationId: orgId, limit: 100, caller: { id: userId } });
        const tools = Array.isArray(toolResult) ? toolResult : (toolResult as any).tools || [];
        return { total: (toolResult as any).total || tools.length, tools: tools.map((t: any) => ({ id: t.id, name: t.name, type: t.type, status: t.status, description: t.description?.substring(0, 100) })) };
      }
      case 'delete_tool': {
        await get(ToolsService).deleteTool(args.toolId, orgId, userId);
        return { deleted: true, toolId: args.toolId };
      }
      case 'activate_tool': {
        // Generated tools land in DRAFT and a gateway only ever serves
        // ACTIVE ones, so without this the flagship
        // create_api -> import_schema -> create_gateway flow served zero
        // tools. ToolsService has no bulk-activate form (checked), so this
        // loops the same single-tool method the Tools page calls and reports
        // every id individually instead of failing the whole batch on one.
        const ids: string[] = args.toolIds?.length
          ? args.toolIds.map((t: any) => String(t))
          : args.toolId
            ? [String(args.toolId)]
            : [];
        if (ids.length === 0) throw new Error('activate_tool requires toolId or toolIds');
        const toolsSvc = get(ToolsService);
        const activated: Array<{ id: string; name: string; status: string }> = [];
        const failed: Array<{ toolId: string; reason: string }> = [];
        for (const toolId of ids) {
          try {
            const tool: any = await toolsSvc.activateTool(toolId, orgId, userId);
            activated.push({ id: tool.id, name: tool.name, status: tool.status });
          } catch (e: any) {
            failed.push({ toolId, reason: e.message });
          }
        }
        return { requested: ids.length, activatedCount: activated.length, activated, failed };
      }
      case 'list_gateways': {
        // Gateways are MCP, UTCP and Skills; an agent's channels (web chat,
        // widget, messaging, A2A) are listed by list_channels.
        const gwResult = await get(GatewaysService).getGateways({ organizationId: orgId, limit: 50, kind: GatewayKind.TOOL, caller: { id: userId } });
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
        let assignment: AssignmentSummary | null = null;
        let requestedCount = 0;
        let assignmentError: string | null = null;
        const shouldAssign = isToolKind && args.assignTools !== false;
        if (shouldAssign) {
          try {
            const GatewayToolService = require('../gateways/gateway-tool.service').GatewayToolService;
            const gwToolService = this.moduleRef.get(GatewayToolService, { strict: false });
            const toolResult = await get(ToolsService).getTools({ organizationId: orgId, limit: 500, caller: { id: userId } });
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

            requestedCount = toolIds.length;
            if (toolIds.length > 0) {
              const result = await gwToolService.bulkAssociateTools(gateway.id, { toolIds }, orgId, userId);
              assignment = summarizeAssignment(result);
            } else {
              assignment = { toolsAssigned: 0, toolsSkipped: [] };
            }
          } catch (e) {
            // Swallowing this reported a live gateway with a tool count the
            // caller never got. Surface it instead.
            this.logger.warn(`Tool assignment failed: ${e.message}`);
            assignmentError = e.message;
          }
        }

        return {
          id: gateway.id,
          name: gateway.name,
          endpoint: gateway.endpoint,
          type: gateway.type,
          toolsRequested: requestedCount,
          // The number of associations that actually exist -- not the number
          // asked for. bulkAssociateTools only attaches ACTIVE tools, and
          // generated tools land in DRAFT, so these differ routinely.
          toolsAssigned: assignment?.toolsAssigned ?? 0,
          toolsSkipped: assignment?.toolsSkipped ?? [],
          ...(assignment?.hint ? { hint: assignment.hint } : {}),
          ...(assignmentError ? { toolAssignmentError: assignmentError } : {}),
        };
      }
      case 'assign_tools_to_gateway': {
        const GatewayToolService = require('../gateways/gateway-tool.service').GatewayToolService;
        const gwToolService = this.moduleRef.get(GatewayToolService, { strict: false });
        let toolIds: string[] = args.toolIds || [];
        if (args.apiName && toolIds.length === 0) {
          // Find all tools from this API by name
          const toolResult = await get(ToolsService).getTools({ organizationId: orgId, limit: 500, caller: { id: userId } });
          const tools = Array.isArray(toolResult) ? toolResult : (toolResult as any).tools || [];
          const apiTools = tools.filter((t: any) => t.api?.name?.toLowerCase() === args.apiName.toLowerCase() || t.name?.toLowerCase().startsWith(args.apiName.toLowerCase().replace(/[^a-z0-9]/g, '_')));
          toolIds = apiTools.map((t: any) => t.id);
        }
        if (toolIds.length === 0) return { error: 'No tools found to assign' };
        const result = await gwToolService.bulkAssociateTools(args.gatewayId, { toolIds }, orgId, userId);
        return { gatewayId: args.gatewayId, requested: toolIds.length, ...summarizeAssignment(result) };
      }
      case 'add_auth_to_gateway': {
        const GatewayAuthService = require('../gateways/gateway-auth.service').GatewayAuthService;
        const gwAuthService = this.moduleRef.get(GatewayAuthService, { strict: false });
        // Per-type configuration now reaches the service. Without it `jwt`
        // was rejected outright (it requires configuration.secret) and the
        // enum advertised a type this tool could not produce. api_key keeps
        // its defaults only when the caller supplies nothing.
        const config: Record<string, any> = { ...(args.configuration || {}) };
        if (args.type === 'api_key' && !config.keyHeader && !config.keyQuery) {
          config.keyHeader = 'x-api-key';
          config.keyQuery = 'api_key';
        }
        const auth = await gwAuthService.createGatewayAuth(args.gatewayId, { type: args.type, configuration: config }, orgId);
        return {
          id: auth.id,
          type: auth.type,
          gatewayId: args.gatewayId,
          // Key names only -- never the values, which can be a shared secret.
          configuredKeys: Object.keys(config),
        };
      }
      case 'remove_auth_from_gateway': {
        const GatewayAuthService = require('../gateways/gateway-auth.service').GatewayAuthService;
        const gwAuthService = this.moduleRef.get(GatewayAuthService, { strict: false });
        await gwAuthService.deleteGatewayAuth(args.authId, orgId);
        return { deleted: true, authId: args.authId };
      }
      case 'list_agents': {
        const agResult: any = await get(AgentsService).getAgents({ organizationId: orgId, limit: 50, caller: { id: userId } });
        const agents = Array.isArray(agResult) ? agResult : (agResult?.data || agResult?.agents || []);
        return { total: agResult?.total || agResult?.pagination?.total || agents.length, agents: agents.map((a: any) => ({ id: a.id, name: a.name, mode: a.mode, status: a.status, slug: a.name?.toLowerCase().replace(/\s+/g, '-') })) };
      }
      case 'create_agent': {
        const agent: any = await get(AgentsService).createAgent({ ...args }, orgId, userId);
        // A freshly created agent is DRAFT, and invoke refuses anything but
        // ACTIVE. Say so in the result rather than letting the caller find
        // out by having invoke_agent refuse.
        return {
          id: agent.id,
          name: agent.name,
          mode: agent.mode,
          status: agent.status,
          nextStep:
            agent.status === AgentStatus.ACTIVE
              ? undefined
              : 'Agent is not active yet. Call activate_agent before invoke_agent.',
        };
      }
      case 'update_agent': {
        const { agentId, ...patch } = args;
        const agent: any = await get(AgentsService).updateAgent(String(agentId), patch, orgId, userId);
        return {
          id: agent.id,
          name: agent.name,
          mode: agent.mode,
          status: agent.status,
          updatedFields: Object.keys(patch),
        };
      }
      case 'delete_agent': {
        await get(AgentsService).deleteAgent(String(args.agentId), orgId, userId);
        return { deleted: true, agentId: args.agentId };
      }
      case 'activate_agent': {
        const agent: any = await get(AgentsService).activateAgent(String(args.agentId), orgId, userId);
        return { id: agent.id, name: agent.name, mode: agent.mode, status: agent.status };
      }
      case 'deactivate_agent': {
        const agent: any = await get(AgentsService).deactivateAgent(String(args.agentId), orgId, userId);
        return { id: agent.id, name: agent.name, mode: agent.mode, status: agent.status };
      }
      case 'invoke_agent': {
        const started = await this.startInvocation(args, orgId, userId);
        return started.kind === 'workflow' ? started.payload : autonomousSummary(started.run);
      }
      case 'get_run': {
        const run = await this.readableRun(String(args.runId), orgId, userId);
        return this.agentRuns().describeRun(run, userId);
      }
      case 'answer_run': {
        const run = await this.readableRun(String(args.runId), orgId, userId);
        if (run.status !== 'waiting_input') {
          throw new Error(`This run is ${run.status}, not waiting for an answer. Call get_run to see what it waits for.`);
        }
        if (typeof args.answer !== 'string' || !args.answer.trim()) throw new Error('answer_run requires a non-empty answer');
        await get(AgentRuntimeService).sendInput(run.id, orgId, String(args.answer));
        return { runId: run.id, status: 'running', next: 'The run continues with your answer. Call get_run to follow it.' };
      }
      case 'list_providers': return get(LlmProvidersService).getProviders({ organizationId: orgId, caller: { id: userId } });
      case 'add_provider': return get(LlmProvidersService).createProvider({ name: args.name, type: args.type, configuration: { apiKey: args.apiKey } }, orgId, userId);

      // -- Channels on an agent --
      case 'list_channels': {
        const channels = await get(AgentChannelsService).list(orgId, args.agentId, { id: userId });
        return { total: channels.length, channels: channels.map(channelSummary) };
      }
      case 'add_channel': {
        const channel = await get(AgentChannelsService).add(orgId, args.agentId, { id: userId }, {
          type: args.type,
          name: args.name,
          slug: args.slug,
          configuration: args.configuration ?? {},
          credentialId: args.credentialId ?? undefined,
        });
        return channelSummary(channel);
      }
      case 'get_channel': {
        const channel = await get(AgentChannelsService).get(orgId, args.agentId, args.channelId, { id: userId });
        return { ...channelSummary(channel), effective: channel.effective };
      }
      case 'check_channel': return get(AgentChannelsService).check(orgId, args.agentId, args.channelId, { id: userId });
      case 'update_channel': {
        const { agentId, channelId, ...patch } = args;
        const channel = await get(AgentChannelsService).update(orgId, agentId, channelId, { id: userId }, patch);
        return channelSummary(channel);
      }
      case 'delete_channel': {
        await get(AgentChannelsService).remove(orgId, args.agentId, args.channelId, { id: userId });
        return { deleted: true };
      }
      case 'publish_channel': {
        const channel = await get(AgentChannelsService).publish(orgId, args.agentId, args.channelId, { id: userId });
        return channelSummary(channel);
      }
      case 'unpublish_channel': {
        const channel = await get(AgentChannelsService).unpublish(orgId, args.agentId, args.channelId, { id: userId });
        return channelSummary(channel);
      }
      case 'get_public_settings': return get(AgentChannelsService).publicSettings(orgId, args.agentId, { id: userId });
      case 'update_public_settings': {
        const { agentId, ...patch } = args;
        return get(AgentChannelsService).updatePublicSettings(orgId, agentId, { id: userId }, patch);
      }
      case 'build_channel': {
        const { agentId, channelId, ...dto } = args;
        await get(AgentChannelsService).manageableAgent(orgId, agentId, { id: userId });
        const channel = await get(AgentChannelsService).get(orgId, agentId, channelId, { id: userId });
        const build: any = await get(AppBuildsService).request(orgId, channel, dto, userId);
        return { id: build.id, status: build.status, type: build.target, platform: build.platform, version: build.version };
      }
      case 'list_builds': {
        const channel = await get(AgentChannelsService).get(orgId, args.agentId, args.channelId, { id: userId });
        const builds = await get(AppBuildsService).list(orgId, channel.id);
        return { total: builds.length, builds: builds.map((b: any) => ({ id: b.id, type: b.target, platform: b.platform, version: b.version, status: b.status, signed: b.signed })) };
      }

      // ── Memory (canonical) ─────────────────────────────────────
      case 'memory_put': {
        const memSvc = get(CanonicalMemoryService);
        const mode = args.mode as Mode;
        const scope_type = (args.scope_type as ScopeType) || 'workspace';
        // Never args.scope_id. The org id is not a secret -- it travels in
        // headers, invite links and gateway URLs -- so accepting it here let
        // any client authorized on org A's gateway read, write and repoint
        // org B's memory.
        const scope_id = orgId;
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
            scope_id: orgId,
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
            scope_id: orgId,
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
        const item = await get(CanonicalMemoryService).get(String(args.id), orgId);
        return item ?? { error: { kind: 'not_found', id: args.id } };
      }
      case 'memory_delete': {
        const ok = await get(CanonicalMemoryService).delete(
          String(args.id),
          orgId,
          (args.mode as 'soft' | 'hard') ?? 'soft',
          { user_id: userId },
        );
        return { deleted: ok, id: args.id };
      }
      case 'memory_supersede': {
        const memSvc = get(CanonicalMemoryService);
        // The replacement row must land in the SAME scope as the row it
        // replaces. The old row's id alone does not determine that here:
        // supersede() looks the old row up by (id, scope_id=orgId) only, so
        // a `user`- or `project`-scoped row supersedes fine and the new row
        // was then written with a hardcoded scope_type of 'workspace' --
        // the correction landed in a different scope than the fact it
        // corrected, leaving the original invisible to its own scope.
        // Read the old row and inherit its scope instead.
        const oldItem = await memSvc.get(String(args.old_id), orgId);
        if (!oldItem) return { error: { kind: 'not_found', id: args.old_id } };
        const requestedScope = args.scope_type as ScopeType | undefined;
        if (requestedScope && requestedScope !== oldItem.scope_type) {
          return {
            error: {
              kind: 'scope_mismatch',
              id: args.old_id,
              actual_scope_type: oldItem.scope_type,
              requested_scope_type: requestedScope,
            },
          };
        }
        const scope_type: ScopeType = oldItem.scope_type ?? 'workspace';
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
          const result = await memSvc.supersede(
            String(args.old_id),
            orgId,
            {
              mode: 'memory',
              scope: { scope_type, scope_id: orgId },
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
            scope_type,
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
            scope_id: orgId,
          },
          { force: !!args.force },
        );
      case 'memory_transfer':
        return get(MemoryRouter).transfer(
          {
            scope_type: (args.scope_type as ScopeType) || 'workspace',
            scope_id: orgId,
          },
          String(args.source),
          String(args.target),
          { mode: args.mode as Mode, dry_run: !!args.dry_run },
        );
      case 'memory_sync':
        return get(MemorySyncService).sync({
          scope_type: (args.scope_type as ScopeType) || 'workspace',
          scope_id: orgId,
        });
      case 'memory_list_backends':
        return get(MemoryRouter).list_backends();
      case 'memory_backends_health':
        return get(MemoryRouter).healthAll();

      // ── Models: catalog, selectability, routing, deployments, registry ──
      case 'list_models': {
        const cards = await get(ModelCatalogService).list(orgId, {
          status: args.status,
          privacyTier: args.privacyTier,
          providerId: args.providerId,
          selectable: args.selectable,
        }, userId ?? null);
        return { total: cards.length, models: cards.map(modelCardView) };
      }
      case 'sync_models': {
        const catalog = get(ModelCatalogService);
        // Mirrors POST /models/sync: one provider when named, every active
        // provider otherwise. Cards, not ids, come back from the service;
        // only the created ones are worth printing in full.
        const summary: any = args.providerId
          ? await catalog.syncFromProvider(orgId, String(args.providerId), userId)
          : await catalog.syncAll(orgId, userId);
        return {
          created: (summary?.created ?? []).map(modelCardView),
          skipped: summary?.skipped ?? 0,
          retired: (summary?.retired ?? []).map((c: any) => ({ id: c.id, name: c.name })),
          reinstated: (summary?.reinstated ?? []).map((c: any) => ({ id: c.id, name: c.name })),
          providers: summary?.providers,
        };
      }
      case 'validate_model': {
        const outcome = await get(ModelCatalogService).validate(orgId, String(args.modelId), userId);
        return {
          passed: outcome.passed,
          error: outcome.error ?? null,
          latencyMs: outcome.latencyMs ?? null,
          model: modelCardView(outcome.model),
        };
      }
      case 'preview_model_routing': {
        const policy: RoutingPolicy = {
          objective: args.objective,
          privacyTier: args.privacyTier,
          regions: args.regions,
          capabilities: args.capabilities,
          fallbackChain: args.fallbackChain,
          pinnedModel: args.pinnedModel,
          budgetHeadroomCents: args.budgetHeadroomCents,
          connectionPreference: args.connectionPreference,
        };
        return get(ModelRouterService).preview(orgId, policy, { id: userId });
      }
      case 'list_model_deployments': {
        const rows = await get(ModelDeploymentsService).list(orgId);
        return { total: rows.length, deployments: rows.map((d) => d.toPublicView()) };
      }
      case 'list_model_versions': {
        const rows = await get(ModelVersionsService).list(orgId);
        return {
          total: rows.length,
          versions: rows.map((v) => ({
            id: v.id, name: v.name, registryUri: v.registryUri, base: v.base,
            quantizations: v.quantizations, sizeBytes: v.sizeBytes,
            manifestSha: v.manifestSha, createdAt: v.createdAt,
          })),
        };
      }

      // ── Connections + credentials ──────────────────────────────
      case 'list_connectors': {
        const rows = await get(ConnectionsService).describeConnectors(orgId, args.kind);
        return {
          total: rows.length,
          connectors: rows.map((c) => ({
            key: c.key,
            kind: c.kind,
            displayName: c.displayName,
            description: c.description ?? null,
            capabilities: c.capabilities ?? [],
            scopesNeeded: c.scopesNeeded ?? [],
            keyPageUrl: c.keyPageUrl ?? null,
            docsUrl: c.docsUrl ?? null,
            // Field NAMES only. The schema is what a form needs; the
            // values are secrets and never travel through this server.
            connect: c.connect.map((m) => ({
              type: m.type,
              label: m.label ?? null,
              fields: Object.keys(m.schema?.properties ?? {}),
              required: m.schema?.required ?? [],
            })),
          })),
        };
      }
      case 'list_connections': {
        const rows = await get(ConnectionsService).list(await this.connectionPrincipal(userId), orgId);
        return { total: rows.length, connections: rows };
      }
      case 'start_connection':
        // No `input`: the HTTP DTO accepts one, but a raw secret must not
        // ride an MCP argument. A form method therefore refuses here with
        // the connector's own field list, which is the useful answer.
        return get(ConnectionsService).connect(
          await this.connectionPrincipal(userId),
          orgId,
          String(args.connectorKey),
          { method: args.method, owner: args.owner, mode: args.mode, name: args.name },
        );
      case 'complete_connection':
        return get(ConnectionsService).complete(String(args.state), String(args.code));
      case 'list_connection_grants': {
        const grants = await get(GrantsService).list(
          String(args.connectionId),
          await this.connectionPrincipal(userId),
          orgId,
        );
        return { total: grants.length, grants };
      }
      case 'grant_connection':
        return get(GrantsService).grant(
          String(args.connectionId),
          {
            principalType: args.principalType,
            principalId: String(args.principalId),
            permission: args.permission,
            budgetId: args.budgetId ?? null,
            expiresAt: args.expiresAt ?? null,
          },
          await this.connectionPrincipal(userId),
          orgId,
        );
      case 'list_credentials': {
        const rows = await get(CredentialsService).findAll({ id: userId }, orgId);
        return {
          total: rows.length,
          credentials: rows.map((c: any) => ({
            id: c.id, name: c.name, type: c.type, isActive: c.isActive,
            connectorKey: c.connectorKey ?? null, accountLabel: c.accountLabel ?? null,
            healthStatus: c.healthStatus ?? null, lastUsedAt: c.lastUsedAt ?? null,
            usedBy: c.usedBy ?? [],
          })),
        };
      }

      // ── Runners + workspaces ───────────────────────────────────
      case 'list_runners': {
        const [runners, workspaces] = await Promise.all([
          get(RunnerService).listForOwner(userId, orgId),
          get(WorkspaceService).listForOwner(userId, orgId),
        ]);
        return {
          runners: runners.map((r) => ({
            id: r.id, name: r.name, state: r.state, visibility: r.visibility,
            teamId: r.teamId, labels: r.labels, runtimeInfo: r.runtimeInfo,
            lastHeartbeatAt: r.lastHeartbeatAt, registeredAt: r.registeredAt,
          })),
          workspaces: workspaces.map((w) => ({
            id: w.id, runnerId: w.runnerId, cwd: w.cwd, isolation: w.isolation,
            status: w.status, ttlAt: w.ttlAt, createdAt: w.createdAt, closedAt: w.closedAt,
          })),
        };
      }

      // ── Organization ───────────────────────────────────────────
      case 'list_org_members': {
        const members = await get(OrganizationsService).getMembers(orgId, userId);
        return {
          total: members.length,
          members: members.map((m: any) => ({
            userId: m.userId, email: m.email, firstName: m.firstName, lastName: m.lastName,
            role: m.role, joinedAt: m.joinedAt, isActive: m.isActive,
          })),
        };
      }

      // ── Cost governance ────────────────────────────────────────
      case 'list_budgets': {
        const rows = await get(BudgetsService).list(orgId, userId);
        return {
          total: rows.length,
          budgets: rows.map((b) => ({
            id: b.id, agentId: b.agentId, llmProviderId: b.llmProviderId,
            periodType: b.periodType, limitCents: b.limitCents, behavior: b.behavior,
            softThresholdPct: b.softThresholdPct, active: b.active,
          })),
        };
      }
      case 'get_spend': {
        const periodType = args.period === 'day' ? 'day' : 'month';
        const from = startOfPeriod(periodType, new Date());
        const summary = await get(SpendService).getSummary(orgId, {
          from,
          granularity: args.granularity ?? 'day',
          viewerId: userId ?? null,
        });
        return { period: periodType, from, ...summary };
      }

      // ── Analytics + monitoring ─────────────────────────────────
      case 'get_analytics': {
        const timeframe = String(args.timeframe ?? '7d');
        switch (args.report) {
          case 'overview':
            return get(AnalyticsService).getOverview(orgId, userId);
          case 'tools':
            return get(AnalyticsService).getToolUsage(orgId, timeframe, userId);
          case 'gateways':
            return get(AnalyticsService).getGatewayUsage(orgId, timeframe, userId);
          case 'models':
            return get(AnalyticsService).getLlmUsage(orgId, timeframe, userId);
          case 'agent_runs':
            return get(AnalyticsService).getAgentRunsSummary(orgId, userId);
          case 'alerts': {
            const alerts = await get(MonitoringService).getActiveAlerts(orgId);
            return { total: alerts.length, alerts };
          }
          case 'routing_failures': {
            // Same window clamp as GET /analytics/routing/failure-rate:
            // nonsense in means the default, not one day's worth.
            const asked = Number(args.days);
            const windowDays = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 90) : 30;
            const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
            const executions = await this.moduleRef
              .get<Repository<AgentExecution>>(getRepositoryToken(AgentExecution) as any, { strict: false })
              .find({
                where: { organizationId: orgId, createdAt: MoreThan(since) },
                select: { id: true, agentId: true, nodeResults: true as any },
                take: 5000,
              });
            const stats = computeCoFailure([
              ...attemptsFrom(executions as any),
              ...failedAttemptsFrom(executions as any),
            ]);
            return {
              windowDays,
              minimumRequests: MIN_COMPARABLE_REQUESTS,
              perAgent: stats.map((s) => ({
                agentId: s.taskClass,
                comparableRequests: s.comparableRequests,
                allModelFailureRate: s.coFailureRate,
                recoverableRate: s.routingHeadroomRate,
                reportable: isReportable(s),
              })),
            };
          }
          default:
            throw new Error(`Unknown analytics report: ${args.report}`);
        }
      }

      // ── Tool hub ───────────────────────────────────────────────
      case 'list_tool_templates': {
        const result = await get(ToolHubService).listTemplates(
          {
            category: args.category,
            provider: args.provider,
            search: args.search,
            page: args.page,
            limit: args.limit,
          },
          orgId,
        );
        return {
          total: result.total,
          templates: result.templates.map((t) => ({
            id: t.id, name: t.name, provider: t.provider, category: t.category,
            tags: t.tags, isBuiltIn: t.isBuiltIn, installCount: t.installCount,
            description: t.description?.substring(0, 200),
          })),
        };
      }
      case 'install_tool_template':
        return get(ToolHubService).installTemplate(String(args.templateId), orgId, userId, {
          existingApiId: args.existingApiId,
          credentialId: args.credentialId,
        });

      // ── Approvals ──────────────────────────────────────────────
      case 'list_approvals': {
        const rows = await get(ApprovalsService).listPending({
          organizationId: orgId,
          caller: { id: userId },
        });
        return {
          total: rows.length,
          approvals: rows.map((a) => ({
            id: a.id, runId: a.runId, agentId: a.agentId, toolCallId: a.toolCallId,
            status: a.status, reason: a.reason, teamId: a.teamId,
            expiresAt: a.expiresAt, createdAt: a.createdAt,
          })),
        };
      }
      case 'decide_approval': {
        const approvals = get(ApprovalsService);
        const decision = { decidedBy: userId, decisionReason: args.reason };
        const row = args.decision === 'reject'
          ? await approvals.reject(String(args.approvalId), decision, { id: userId }, orgId)
          : await approvals.approve(String(args.approvalId), decision, { id: userId }, orgId);
        return {
          id: row.id, status: row.status, decidedBy: row.decidedBy,
          decidedAt: row.decidedAt, decisionReason: row.decisionReason,
        };
      }

      default: throw new Error(`Unknown tool: ${name}`);
    }
  }

  /**
   * The connections layer authorizes against memberships, not against a
   * bare user id: ConnectionsService.assertMember refuses a principal
   * with no `organizationMemberships`. The MCP transport only carries
   * (orgId, userId), so load the real memberships rather than forging a
   * principal — forging one would silently grant connections:manage.
   */
  private async connectionPrincipal(userId: string): Promise<{ id: string; organizationMemberships: any[] }> {
    const user: any = await this.moduleRef.get(UsersService, { strict: false }).findOne(userId);
    return { id: user.id, organizationMemberships: user.organizationMemberships ?? [] };
  }
}

/**
 * A model card as an agent needs to read it. `selectable` is the whole
 * point: it is the entity's own rule (active + callable + one passed
 * validation run), so it is computed here rather than re-derived from
 * the fields, which would drift. Cards carry no secrets.
 */
function modelCardView(card: any) {
  return {
    id: card.id,
    name: card.name,
    vendorModelId: card.vendorModelId,
    providerId: card.providerId ?? null,
    providerType: card.providerType ?? null,
    status: card.status,
    validationStatus: card.validationStatus,
    lastValidatedAt: card.lastValidatedAt ?? null,
    lastValidationError: card.lastValidationError ?? null,
    privacyTier: card.privacyTier,
    region: card.region ?? null,
    contextLength: card.contextLength ?? null,
    capabilities: card.capabilities ?? null,
    selectable: typeof card.isSelectable === 'function' ? card.isSelectable() : false,
    effectivePricing: typeof card.effectivePricing === 'function' ? card.effectivePricing() : null,
  };
}

/** A management tool's answer as a tool result: JSON text, and the object as structured content. */
function asToolResult(result: unknown): McpToolResult {
  const structured = result && typeof result === 'object' && !Array.isArray(result) ? result : undefined;
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

/** What invoke_agent answers for an autonomous run it does not wait for: the run id, and how to follow it. */
function autonomousSummary(run: AgentRun): Record<string, unknown> {
  return {
    mode: 'autonomous',
    agentId: run.agentId,
    runId: run.id,
    executionId: run.id,
    status: run.status,
    next: 'Follow the run with get_run; if it asks a question, answer with answer_run.',
  };
}

/** The `{code, message}` an MCP handler throws for a protocol error (never an Error instance). */
function isMcpProtocolError(err: unknown): boolean {
  return !!err && typeof err === 'object' && !(err instanceof Error)
    && typeof (err as any).code === 'number' && typeof (err as any).message === 'string';
}
